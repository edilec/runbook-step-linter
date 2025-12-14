# Replay the parked webhook queue

Owner: integrations-oncall

Deliveries that failed every retry are parked. This runbook replays them once
the downstream fault is fixed. It is safe to stop after any step: nothing here
deletes a parked delivery.

## 1. Confirm the downstream fault is fixed

- **Prerequisites:** the incident that parked the deliveries is marked resolved, and its owner has confirmed the fix is live.
- **Expected output:** a single probe delivery is accepted downstream and appears in the downstream log within one minute.
- **Recovery:** none needed; this step only sends one probe. If the probe fails, stop and reopen the incident rather than replaying the queue.

```sh
./scripts/send-probe-delivery.sh --queue parked
```

## 2. Count what is parked

- **Prerequisites:** step 1 finished and the probe was accepted.
- **Expected output:** a count, written into the incident ticket, and the oldest parked delivery's age. A count above ten thousand means the replay is a separate change, not this runbook.
- **Recovery:** none needed; this step only reads. If the count cannot be obtained, stop: replaying a queue whose size is unknown is how a replay becomes a second incident.

```sh
./scripts/queue-stats.sh --queue parked
```

## 3. Replay in one bounded batch

- **Prerequisites:** step 2 finished and the count is at or below ten thousand.
- **Expected output:** the parked count falls by the batch size, the delivered count rises by the same number, and the downstream error rate stays flat for ten minutes.
- **Recovery:** stop the replay with the queue console, leave the remaining deliveries parked, and reopen the incident. Replayed deliveries are idempotent, so a partial replay needs no undo.

```sh
./scripts/replay-queue.sh --queue parked --batch 500 --rate 20
```

## 4. Close out

- **Prerequisites:** step 3 finished and the downstream error rate stayed flat.
- **Expected output:** the parked queue is empty, and the incident ticket records the replayed count and the batch settings used.
- **Recovery:** if deliveries are still parked, repeat step 3 for the remainder. If the same delivery parks twice, leave it parked and hand it to the integration owner named in the ticket.

```text
Parked queue empty. 1,240 deliveries replayed at 20/s.
```
