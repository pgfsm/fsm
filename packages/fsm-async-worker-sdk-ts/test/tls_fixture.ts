// Throwaway TLS material for tests: a CA, a server certificate for
// localhost/127.0.0.1 and a client certificate (mutual TLS), all signed by
// that CA and made with openssl at test time, so no private key is committed.

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

export interface TestTls {
  dir: string;
  caFile: string;
  certFile: string;
  keyFile: string;
  clientCertFile: string;
  clientKeyFile: string;
}

export async function makeTestTls(): Promise<TestTls> {
  const dir = await Deno.makeTempDir({ prefix: "pgfsm-sdk-tls-" });
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
  for (
    const [name, subject, ext] of [
      [
        "server",
        "/CN=localhost",
        "subjectAltName=DNS:localhost,IP:127.0.0.1\n",
      ],
      ["client", "/CN=pgfsm-test-worker", ""],
    ]
  ) {
    await openssl([
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      `${name}.key`,
      "-out",
      `${name}.csr`,
      "-subj",
      subject,
    ], dir);
    const extArgs: string[] = [];
    if (ext) {
      await Deno.writeTextFile(`${dir}/${name}.ext`, ext);
      extArgs.push("-extfile", `${name}.ext`);
    }
    await openssl([
      "x509",
      "-req",
      "-in",
      `${name}.csr`,
      "-CA",
      "ca.crt",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-days",
      "1",
      "-out",
      `${name}.crt`,
      ...extArgs,
    ], dir);
  }
  return {
    dir,
    caFile: `${dir}/ca.crt`,
    certFile: `${dir}/server.crt`,
    keyFile: `${dir}/server.key`,
    clientCertFile: `${dir}/client.crt`,
    clientKeyFile: `${dir}/client.key`,
  };
}
