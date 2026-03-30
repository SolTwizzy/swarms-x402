# MCPize Submission

## Status: MANUAL ACTION REQUIRED (CLI with interactive browser auth)

## Steps

```bash
# 1. Login (opens browser)
npx mcpize login

# 2. Analyze project (generates mcpize.yaml)
npx mcpize analyze

# 3. Deploy
npx mcpize deploy
```

## Alternative: Web Form

1. Go to https://mcpize.com/developer/servers/new#endpoint
2. Fill in server details

## Notes

- MCPize hosts and runs the server in their cloud (85% revenue share)
- Since we already self-host on Railway with x402 payments, there may be a hosting conflict
- Consider listing as a "remote" server that points to our Railway URL
- Evaluate whether dual-hosting makes sense for discovery vs our existing monetization
