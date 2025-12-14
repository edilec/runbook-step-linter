# Fail over the primary database

Owner: data-oncall

This runbook is deliberately broken. The two steps below carry the same
heading, and the second one answers nothing about what to do when it fails.

## 1. Promote the replica

- **Prerequisites:** the primary is confirmed unreachable from two regions.
- **Expected output:** the replica reports itself as primary and accepts a write.
- **Recovery:** demote the replica and keep serving reads from it while the incident owner decides.

```sh
./scripts/promote-replica.sh --replica eu-west-2
```

## 2. Promote the replica

- **Prerequisites:** step 1 finished.
- **Expected output:** ???

$ ./scripts/repoint-writers.sh --target eu-west-2
