# Restart the ingest worker

Recovery: page the on-call lead.

This runbook is deliberately broken. Every defect below is one the linter
reports, and the commands in it exist only to be read: the linter never runs
anything it finds in a document.

## 1. Stop the worker

- **Owner:** TBD
- **Expected output:** the unit is reported as inactive.
- **Recovry:** start the unit again.

sudo systemctl stop edilec-ingest && rm -rf /var/lib/ingest/spool

## 2. Clear the spool

- **Owner:** ingest-oncall
- **Prerequisites:** step 1 finished and the unit is inactive.
- **Expected output:** the spool directory is empty.
- **Recovery:** there is nothing to restore; the spool is a cache and is rebuilt on start.

Then run `rm -rf /var/lib/ingest/spool` to clear it.

```
rm -rf /var/lib/ingest/spool
```

## 4. Start the worker

- **Owner:** ingest-oncall
- **Owner:** whoever is around
- **Prerequisites:** step 2 finished and the spool is empty.
- **Recovery:** stop the unit again and hand over to the ingest owner.

```sh
systemctl start edilec-ingest
```
