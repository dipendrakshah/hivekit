# 10 — Security and vault

## What to do

Make the default hard to shoot off a foot.

Work:

1. Vault drivers: file (dev), age (linux), keychain (mac), memory (tests).
2. Pairing: first client owns the Gateway; later clients need token.
3. Redaction in logs and traces.
4. Skill-level stealth block for tax-dashboard.
5. Budget circuit breaker.
6. `hivekit doctor` warns on `expose: true` without TLS.
7. Threat note in README: this is a personal workshop, not a multi-tenant bank.

## Definition of done

- [ ] `grep` of a job trace after a run with a dummy key never contains the raw key.
- [ ] Tax skill + worker model `stealth/ox-alpha` + default config → master is told to reroute. Test covers this.
- [ ] Budget 0.00 blocks the second completion in a stubbed priced model.
- [ ] Doctor fails CI fixture when expose is true and no tls flag is set.
- [ ] Vault file permissions are 0600 on Unix.
