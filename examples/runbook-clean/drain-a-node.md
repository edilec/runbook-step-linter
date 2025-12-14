# Drain a Kubernetes node for maintenance

Owner: platform-oncall

This runbook takes one worker node out of service so its host can be patched.
Every step states who runs it, what must already be true, how to tell that it
worked, and what to do when it does not. Commands live in fenced blocks so the
boundary between what to run and what to read is never a guess.

## 1. Confirm the node is safe to drain

- **Prerequisites:** you can reach the cluster API, and the change has been announced in the on-call channel.
- **Expected output:** the node is Ready, and no pod on it is the last healthy replica of its service.
- **Recovery:** none needed; this step only reads. If the node is already NotReady, stop and raise it in the on-call channel instead of draining.

```sh
kubectl get node node-7 -o wide
kubectl get pods --all-namespaces --field-selector spec.nodeName=node-7
```

## 2. Cordon the node

- **Prerequisites:** step 1 finished and the node was Ready.
- **Expected output:** the node is reported as Ready,SchedulingDisabled, and no new pod is placed on it.
- **Recovery:** uncordon the node and stop. Nothing has moved yet, so there is nothing else to undo.

```sh
kubectl cordon node-7
```

```sh
kubectl uncordon node-7
```

## 3. Evict the workloads

- **Prerequisites:** step 2 finished and the node is SchedulingDisabled.
- **Expected output:** eviction finishes with no pod left on the node except the daemon sets, and every service reports its full replica count elsewhere.
- **Recovery:** uncordon the node and let the scheduler place work back on it. If eviction stalls on a disruption budget, leave the node cordoned, stop here, and hand over to the service owner named in the budget.

```sh
kubectl drain node-7 --ignore-daemonsets --delete-emptydir-data --timeout=15m
```

## 4. Hand the host to the platform team

- **Prerequisites:** step 3 finished and no workload remains on the node.
- **Expected output:** the platform team has acknowledged the handover in the change ticket, and the ticket records the node name and the time it was drained.
- **Recovery:** if the handover is refused, uncordon the node and close the change. The node goes back into service unchanged.

```text
Node node-7 drained and cordoned, ready for patching.
```
