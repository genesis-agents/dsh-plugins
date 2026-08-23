# deploy

Configuration that is not code and not documentation: the files a machine
needs to run this deployment, kept in git so a reinstall does not have to
rediscover them.

Neither of these lived here at first. Both were written directly onto the
machine that needed them, and both were one reinstall away from being lost —
along with the reasoning that produced them, which in each case took longer
than the file did.

| File | Goes on | What it fixes |
|---|---|---|
| `remote-picker.yml` | the Mac (the host) | Choosing a workspace silently doing nothing |
| `dsh-tunnel.ps1` | every Windows box | A tunnel that is up but carrying nothing |
| `install-tunnel.ps1` | every Windows box | Registering the above to survive logout |

---

## `remote-picker.yml` — the host

The harness picks its directory-chooser at boot from what it can infer about
the operator: loopback bind, no SSH launch, and a servable display resolve to
`native` (an OS folder dialog), anything ambiguous to `browse` (a directory
list rendered in the page).

On this deployment that inference lands wrong, and the reason is worth keeping.
`directory-picker-auto` explicitly handles the remote-operator case — its own
comment says a native chooser "would open on the unattended server" — but it
detects that case through `SSH_CONNECTION`. This host is started by **launchd**,
not over SSH, so the signal is absent, the resolver sees darwin plus a loopback
bind, and mounts `native`. The dialog then opens on a Mac nobody is sitting at
and the browser waits for a click that cannot happen.

The judgement was right; the signal for it does not exist under launchd. So the
interaction is pinned instead, which is what the auto module documents as the
alternative to its row.

Installed by passing it to the **parent** command:

```sh
dsh --profile web --patch ~/.dsh/patches/remote-picker.yml --no-open
```

Two things cost time here and are easy to repeat:

- **`--patch` belongs to the parent, not to `web`.** `dsh web --patch …` fails
  with *"web takes none of parent --profile, --patch, …"* — into the log, not
  the terminal, so under launchd it presents as a restart loop.
- **A patch's `name` is a guard, not a setter.** Giving an id a different name
  does not rename the entry; it fails the match and the patch is skipped with a
  warning. Replacing an entry means `disabled: true` plus an `insert`.

Confirm the composition before booting it:

```sh
dsh --profile web --patch <file> --dump-config | grep -A2 directory-picker
```

---

## `dsh-tunnel.ps1` — every Windows machine

Full access to the harness requires a **loopback** origin. Fifteen methods —
the whole settings and credentials plane, plus native dialogs — are pinned to
loopback on purpose, and `--trusted-host` does not unlock them: that flag is a
DNS-rebinding fence, not authentication. Through an SSH tunnel the browser's
origin *is* `127.0.0.1`, so everything works.

`tailscale serve` publishes the same harness to the tailnet and is the right
answer for a phone or a quick look — but it cannot open the settings page, and
it is not a replacement.

```powershell
.\install-tunnel.ps1     # once per machine
```

The supervisor checks for an HTTP answer *through* the tunnel rather than for a
live ssh process, because those are not the same thing. An ssh session can lose
the far end and keep running: the process is alive, the port is still bound,
and every request hangs. A restart-on-exit supervisor never fires, since
nothing exited — and from the browser it is indistinguishable from the service
being down, which is exactly how an afternoon gets spent debugging the wrong
machine.

Three consecutive missed probes replace the ssh we started, tracked by PID so
other ssh sessions on the machine are left alone. Log: `~/.dsh-tunnel.log`.

It will also recycle when the *remote service* is down, where reconnecting
cannot help. That is deliberate: the probe cannot tell the two apart, and a
reconnect attempt every minute or so is a much cheaper mistake than a dead
tunnel nobody notices.

---

## A new Windows machine

1. Install Tailscale, sign in to the tailnet.
2. Copy an SSH key to `~/.ssh/id_ed25519` and authorize it on the Mac.
3. `.\install-tunnel.ps1`
4. Open `http://127.0.0.1:3080`.

Nothing else is per-machine — the library, both timers, and every setting live
on the Mac. See [`../docs/mac-mini.md`](../docs/mac-mini.md) for that side and
[`../docs/architecture.md`](../docs/architecture.md) for why it is split this
way.
