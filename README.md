# WhatsArab SDKs

Official TypeScript and Python clients for the [WhatsArab](https://whatsarab.com) API.

WhatsArab is an Arabic-first WhatsApp Business platform for teams across the Middle East and North Africa, built on Meta's official WhatsApp Business Cloud API. With these clients you can send WhatsApp messages from any of your numbers, upload and download media, manage message templates, send and verify one-time codes, manage contacts and tags, and verify signed webhooks.

| Language | Package | Install | Guide |
|---|---|---|---|
| TypeScript / JavaScript | [`@whatsarab/sdk`](https://www.npmjs.com/package/@whatsarab/sdk) | `npm install @whatsarab/sdk` | [typescript/README.md](typescript/README.md) |
| Python | [`whatsarab`](https://pypi.org/project/whatsarab/) | `pip install whatsarab` | [python/README.md](python/README.md) |

## Quick start

TypeScript (Node 18 or newer):

```ts
import { WhatsArab } from '@whatsarab/sdk';

const wa = new WhatsArab({ apiKey: process.env.WHATSARAB_API_KEY! });

// An approved template — works any time
await wa.messages.send({
  to: '201234567890',
  template: 'order_shipped',
  language: 'ar',
  components: [{ type: 'body', parameters: [{ type: 'text', text: '10428' }] }],
});
```

Python (3.9 or newer):

```python
import os
from whatsarab import WhatsArab

wa = WhatsArab(api_key=os.environ["WHATSARAB_API_KEY"])

# Free-form text — only inside the 24-hour customer-service window
wa.messages.send(to="201234567890", text="أهلًا يا سارة! طلبك رقم ١٠٤٢٨ خرج للتوصيل.")
```

Create an API key in your WhatsArab workspace under **Integrations → API keys**. A key is shown once, when you create it.

## Documentation

- [API documentation](https://whatsarab.com/docs): every endpoint, with samples in both languages
- [Error codes](https://whatsarab.com/docs/errors)
- [OpenAPI document](https://whatsarab.com/public/openapi.json)
- [Integrations](https://whatsarab.com/integrations), including the verified [n8n node](https://github.com/WhatsArabHQ/n8n-nodes-whatsarab)

## Repository layout

```
typescript/   @whatsarab/sdk — source, tests and type checks
python/       whatsarab — source and tests
```

Both clients cover the same API surface and are released together under the same version number. The changelog for each release is at the end of each package's README.

## Support and security

- Questions and bug reports: [whatsarab.com/support](https://whatsarab.com/support)
- Security issues: please report them privately to security@whatsarab.com rather than in a public issue.

This repository is published from WhatsArab's main codebase, so changes are made there and then synced here. Pull requests cannot be merged directly; if you find a problem, please tell us through support and we will fix it at the source.

## License

[MIT](LICENSE)
