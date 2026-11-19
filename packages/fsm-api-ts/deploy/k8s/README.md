# Kubernetes reference manifests for the pgfsm API (SPEC-016)

```
base/                 kubectl apply -k base
  namespace.yaml      namespace "pgfsm", Pod Security "restricted" enforced
  api.yaml            pgfsm-api: /instances and /definitions (2 replicas) + Service
  api-admin.yaml      pgfsm-api-admin: also /admin/* (1 replica) + internal Service
../docker/            the image's Dockerfile
```

The image is published with every release as `ghcr.io/pgfsm/api:<version>`
(amd64 and arm64, with build provenance); `base/` pulls the current one. Check
where it came from with
`gh attestation verify oci://ghcr.io/pgfsm/api:<version> --owner pgfsm`.

## Before applying

1. **fsm_core installed** in the database (the full install,
   `fsm_core--<version>.sql`, or the PGXN extension; see
   `packages/database-src/README.md`). The API refuses to start on an fsm_core
   it doesn't support, naming the upgrade scripts to apply.

2. **Database logins** (SPEC-009 §1), as the database owner. The install creates
   `fsm_authenticator` (LOGIN, NOINHERIT, member of `fsm_operator`, no password)
   for `pgfsm-api`. `pgfsm-api-admin` gets its own NOINHERIT login that may also
   act as `fsm_admin`; being NOINHERIT, it needs its own grants for what it runs
   before switching role:

   ```sql
   ALTER ROLE fsm_authenticator PASSWORD '…';
   CREATE ROLE fsm_authenticator_admin LOGIN NOINHERIT PASSWORD '…'
     IN ROLE fsm_operator, fsm_admin;
   GRANT USAGE ON SCHEMA fsm_core TO fsm_authenticator_admin;
   GRANT EXECUTE ON FUNCTION fsm_core.verify_api_key(bytea), fsm_core.version()
     TO fsm_authenticator_admin;
   ```

3. **Secrets**, each with a `DATABASE_URL` (point them at your pooler):

   ```bash
   kubectl -n pgfsm create secret generic pgfsm-api-db \
     --from-literal=DATABASE_URL='postgres://fsm_authenticator:…@pooler/postgres'
   kubectl -n pgfsm create secret generic pgfsm-api-admin-db \
     --from-literal=DATABASE_URL='postgres://fsm_authenticator_admin:…@pooler/postgres'
   ```

4. **The first admin key**, once, from a machine that can reach the database as
   its owner. It prints the key once:

   ```bash
   npx @pgfsm/api key bootstrap --db-url 'postgres://owner:…@db/postgres'
   ```

## Using it

```bash
kubectl apply -k base
kubectl -n pgfsm port-forward svc/pgfsm-api-admin 9999:80
pgfsmctl config set --url http://127.0.0.1:9999/api/v1 --api-key <admin key>
pgfsmctl key create --name ci --role operator      # keys for services
pgfsmctl scheduler status                           # the pg_cron job
```

Expose `pgfsm-api` to your services (an Ingress, or in-cluster only), never
`pgfsm-api-admin`.
