// SPEC-007 transport over real sockets: a TLS TCP sidecar listener (with a
// throwaway CA made by openssl, so no key is ever committed) next to a Unix
// one. A token-bearing TLS client registers and serves an invoke; a client
// without the token gets UNAUTHENTICATED; a plaintext client can't talk to
// the TLS port.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import {
  createGrpcTransport,
  Http2SessionManager,
} from "@connectrpc/connect-node";
import * as net from "node:net";
import { SidecarGatewayService } from "@pgfsm/proto-codegen/sidecargateway/v1/connect";
import {
  InvokeResult,
  Register,
  RegisteredActor,
  SessionRequest,
  type SessionResponse,
} from "@pgfsm/proto-codegen/sidecargateway/v1/pb";
import { SidecarGateway } from "../src/sidecar/gateway.ts";

type SessionRequestMessage = InstanceType<typeof SessionRequest>;
type SessionResponseMessage = InstanceType<typeof SessionResponse>;

const ACTOR = {
  parentFsmName: "creditCheck",
  parentFsmVersion: "v01",
  asyncOperationType: "internalAsyncOperation",
  asyncOperationName: "checkBureau",
  asyncOperationVersion: "v01",
  asyncOperationLanguage: "go",
};

async function openssl(args: string[], cwd: string): Promise<void> {
  const { code, stderr } = await new Deno.Command("openssl", {
    args,
    cwd,
    stdout: "null",
    stderr: "piped",
  }).output();
  if (code !== 0) {
    throw new Error(
      `openssl ${args[0]} failed: ${new TextDecoder().decode(stderr)}`,
    );
  }
}

/**
 * A CA, a server cert for localhost/127.0.0.1 and a client cert (for mutual
 * TLS), all signed by that CA, in a temp dir.
 */
export async function makeTestTls(): Promise<{
  dir: string;
  caFile: string;
  certFile: string;
  keyFile: string;
  clientCertFile: string;
  clientKeyFile: string;
}> {
  const dir = await Deno.makeTempDir({ prefix: "pgfsm-tls-" });
  await openssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-keyout",
    "ca.key",
    "-out",
    "ca.crt",
    "-subj",
    "/CN=pgfsm-test-ca",
  ], dir);
  await openssl([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "server.key",
    "-out",
    "server.csr",
    "-subj",
    "/CN=localhost",
  ], dir);
  await Deno.writeTextFile(
    `${dir}/san.ext`,
    "subjectAltName=DNS:localhost,IP:127.0.0.1\n",
  );
  await openssl([
    "x509",
    "-req",
    "-in",
    "server.csr",
    "-CA",
    "ca.crt",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-days",
    "1",
    "-out",
    "server.crt",
    "-extfile",
    "san.ext",
  ], dir);
  await openssl([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "client.key",
    "-out",
    "client.csr",
    "-subj",
    "/CN=pgfsm-test-worker",
  ], dir);
  await openssl([
    "x509",
    "-req",
    "-in",
    "client.csr",
    "-CA",
    "ca.crt",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-days",
    "1",
    "-out",
    "client.crt",
  ], dir);
  return {
    dir,
    caFile: `${dir}/ca.crt`,
    certFile: `${dir}/server.crt`,
    keyFile: `${dir}/server.key`,
    clientCertFile: `${dir}/client.crt`,
    clientKeyFile: `${dir}/client.key`,
  };
}

class PushStream<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = [];
  private readonly waiting: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;
  push(item: T): void {
    const next = this.waiting.shift();
    if (next) next({ value: item, done: false });
    else this.buffered.push(item);
  }
  close(): void {
    this.closed = true;
    for (const resolve of this.waiting.splice(0)) {
      resolve({ value: undefined, done: true });
    }
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffered.length > 0) {
          return Promise.resolve({
            value: this.buffered.shift()!,
            done: false,
          });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.waiting.push(resolve));
      },
      return: (value?: T) => {
        this.close();
        return Promise.resolve({ value: value as T, done: true });
      },
      throw: (error?: unknown) => {
        this.close();
        return Promise.reject(error);
      },
    };
  }
}

interface RawClient {
  session(
    requests: AsyncIterable<SessionRequestMessage>,
    options?: { headers?: HeadersInit },
  ): AsyncIterable<SessionResponseMessage>;
}

/** Opens a Session, registers, and returns the response iterator. */
function openSession(
  manager: Http2SessionManager,
  baseUrl: string,
  token?: string,
) {
  const client = createClient(
    SidecarGatewayService,
    createGrpcTransport({ baseUrl, httpVersion: "2", sessionManager: manager }),
  ) as unknown as RawClient;
  const requests = new PushStream<SessionRequestMessage>();
  requests.push(
    new SessionRequest({
      payload: {
        case: "register",
        value: new Register({
          workerId: `w-${crypto.randomUUID()}`,
          language: "go",
          protocolVersion: "1.0",
          actors: [new RegisteredActor({ ...ACTOR, maxConcurrency: 2 })],
        }),
      },
    }),
  );
  const responses = client.session(requests, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })[Symbol.asyncIterator]();
  return { requests, responses };
}

Deno.test("sidecar serves TLS TCP with a token, next to a Unix socket", async () => {
  const tls = await makeTestTls();
  const tokenFile = `${tls.dir}/token`;
  await Deno.writeTextFile(tokenFile, "s3cret\n");
  const socketPath = `${tls.dir}/workers.sock`;
  const gateway = new SidecarGateway({
    socketPath,
    listeners: [{
      kind: "tcp",
      host: "127.0.0.1",
      port: 0,
      tls: { certFile: tls.certFile, keyFile: tls.keyFile },
    }],
    authTokenFile: tokenFile,
    shutdownGraceMs: 200,
  });
  await gateway.start();
  const managers: Http2SessionManager[] = [];
  try {
    const tcp = gateway.addresses()[1];
    assert(tcp.kind === "tcp" && tcp.port > 0);
    const httpsUrl = `https://localhost:${tcp.port}`;
    const ca = await Deno.readTextFile(tls.caFile);

    // Token + trusted CA: registers and serves an invoke.
    const tlsManager = new Http2SessionManager(httpsUrl, undefined, { ca });
    managers.push(tlsManager);
    const worker = openSession(tlsManager, httpsUrl, "s3cret");
    const ack = await worker.responses.next();
    assertEquals(ack.value?.payload.case, "registerAck");
    assertEquals(gateway.routingSnapshot()[0].maxConcurrency, 2);

    const invoked = gateway.invoke({
      ...ACTOR,
      input: { n: 1 },
      instanceId: "i",
      correlationId: "c",
    }, 5_000);
    const next = await worker.responses.next();
    assertEquals(next.value?.payload.case, "invoke");
    const invokeId = next.value?.payload.case === "invoke"
      ? next.value.payload.value.invokeId
      : "";
    worker.requests.push(
      new SessionRequest({
        payload: {
          case: "invokeResult",
          value: new InvokeResult({ invokeId, outputJson: '{"ok":true}' }),
        },
      }),
    );
    assertEquals((await invoked).output, { ok: true });
    worker.requests.close();

    // No token: refused before registration.
    const anonManager = new Http2SessionManager(httpsUrl, undefined, { ca });
    managers.push(anonManager);
    const anon = openSession(anonManager, httpsUrl);
    const refused = await assertRejects(() => anon.responses.next());
    assertEquals((refused as ConnectError).code, Code.Unauthenticated);

    // Plaintext client against the TLS port: fails outright.
    const plainUrl = `http://127.0.0.1:${tcp.port}`;
    const plainManager = new Http2SessionManager(plainUrl);
    managers.push(plainManager);
    const plain = openSession(plainManager, plainUrl, "s3cret");
    await assertRejects(() => plain.responses.next());

    // The Unix listener still works without a token.
    const unixManager = new Http2SessionManager("http://localhost", undefined, {
      createConnection: () => net.connect(socketPath),
    });
    managers.push(unixManager);
    const unixWorker = openSession(unixManager, "http://localhost");
    const unixAck = await unixWorker.responses.next();
    assertEquals(unixAck.value?.payload.case, "registerAck");
    unixWorker.requests.close();
  } finally {
    for (const manager of managers) manager.abort();
    await gateway.stop();
    await Deno.remove(tls.dir, { recursive: true });
  }
});

Deno.test("mutual TLS: a CA-signed client certificate is required, and TLS 1.2 is refused by default", async () => {
  const tls = await makeTestTls();
  const gateway = new SidecarGateway({
    listeners: [{
      kind: "tcp",
      host: "127.0.0.1",
      port: 0,
      tls: {
        certFile: tls.certFile,
        keyFile: tls.keyFile,
        clientCaFile: tls.caFile,
      },
    }],
    shutdownGraceMs: 200,
  });
  await gateway.start();
  const managers: Http2SessionManager[] = [];
  try {
    const tcp = gateway.addresses()[0];
    assert(tcp.kind === "tcp");
    const url = `https://localhost:${tcp.port}`;
    const ca = await Deno.readTextFile(tls.caFile);
    const cert = await Deno.readTextFile(tls.clientCertFile);
    const key = await Deno.readTextFile(tls.clientKeyFile);

    // With the client certificate: registers, no token needed.
    const withCert = new Http2SessionManager(url, undefined, { ca, cert, key });
    managers.push(withCert);
    const worker = openSession(withCert, url);
    const ack = await worker.responses.next();
    assertEquals(ack.value?.payload.case, "registerAck");
    worker.requests.close();

    // Without one: the TLS handshake itself fails.
    const noCert = new Http2SessionManager(url, undefined, { ca });
    managers.push(noCert);
    await assertRejects(() => openSession(noCert, url).responses.next());

    // A client capped at TLS 1.2: refused by the TLS 1.3 minimum.
    const tls12 = new Http2SessionManager(url, undefined, {
      ca,
      cert,
      key,
      maxVersion: "TLSv1.2",
    });
    managers.push(tls12);
    await assertRejects(() => openSession(tls12, url).responses.next());
  } finally {
    for (const manager of managers) manager.abort();
    await gateway.stop();
    await Deno.remove(tls.dir, { recursive: true });
  }
});
