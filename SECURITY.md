# Security

## Use at your own risk

This project is experimental and provided under the MIT License **“AS IS”**,
without any warranty. You are solely responsible for your wallets, sessions,
addresses, transactions, tax/compliance obligations, and any loss. See
[DISCLAIMER.md](DISCLAIMER.md).

The author and contributors are not liable for lost assets, wrong addresses,
failed transactions, third-party outages, or compromised sessions.

## Reporting

Do not open a public issue containing wallet addresses, QR payloads, session
files, cookies, API keys, or logs with personal data.

Report security issues privately to the repository owner.

## Deployment checklist

- [ ] Bind the dashboard to `127.0.0.1` only; never expose port 8100.
- [ ] Put an authenticated reverse proxy in front of it. `X-Requested-With` is not auth.
- [ ] Keep BAW sessions under a dedicated OS user with restrictive permissions.
- [ ] Do not commit `data/`, `.env`, BAW session directories, or exported logs.
- [ ] Verify the full recipient address before every transfer.
- [ ] Treat QR codes as address-only; re-check the full address shown under the QR.
- [ ] Rotate credentials immediately if a session, cookie, or token is exposed.
- [ ] Restrict access to `data/tasks.json`, `data/audit.jsonl`, and server logs.

## What this project does not do

- It does not import private keys.
- It does not store seed phrases.
- It does not bypass Binance risk controls or phone confirmation.
- It does not guarantee price, quote, tax, or liquidity accuracy.
- It does not provide an explicit on-chain min-receive check beyond BAW's slippage control.

On-chain transactions are irreversible.
