/**
 * Compile-time contract checks — run by `npm run typecheck`, never executed.
 * A `@ts-expect-error` line that STOPS erroring fails the build, so each
 * promise the types make below cannot regress silently.
 */
import { WhatsArab } from '../src/index';

const wa = new WhatsArab({ apiKey: 'k' });

// An address is exactly one of `to` (phone) and `recipient` (WhatsApp user id).
void wa.messages.send({ to: '201234567890', text: 'hi' });
void wa.messages.send({ recipient: 'EG.13491208655302741918', text: 'hi' });
void wa.messages.send({ recipient: 'EG.13491208655302741918', template: 'order_shipped', language: 'ar' });
// @ts-expect-error both addresses
void wa.messages.send({ to: '201234567890', recipient: 'EG.13491208655302741918', text: 'hi' });
// @ts-expect-error no address
void wa.messages.send({ text: 'hi' });

// A payload is exactly one kind.
// @ts-expect-error two payload kinds
void wa.messages.send({ to: '201234567890', text: 'hi', template: 'order_shipped' });

// templates.availability narrows on the verdict; templates.copy needs both sides.
async function _availabilityContract() {
  const [row] = await wa.templates.availability({ names: ['order_confirmation'], language: 'ar' });
  if (row.verdict === 'not_approved') void row.status.toUpperCase();
  if (row.verdict === 'language_missing') void row.languages.join(',');
  for (const n of row.lackingOn) if (n.verdict === 'language_missing') void n.languages;
  // @ts-expect-error scope is 'all' or a list of ids
  void wa.templates.availability({ names: ['x'], scope: 'everything' });
  // @ts-expect-error a copy names both numbers
  void wa.templates.copy({ name: 'x', language: 'ar', from: 'n1' });
  const copied = await wa.templates.copy({ name: 'x', language: 'ar', from: 'n1', to: 'n2' });
  void copied.to.number_id;
}
void _availabilityContract;

// uploadSample needs a header format, and only the three that take a sample.
async function _uploadSampleContract() {
  const { handle } = await wa.templates.uploadSample(new Blob(['x']), { format: 'DOCUMENT' });
  void handle.length;
  // @ts-expect-error TEXT headers have no sample
  void wa.templates.uploadSample(new Blob(['x']), { format: 'TEXT' });
  // @ts-expect-error the format is required
  void wa.templates.uploadSample(new Blob(['x']), {});
}
void _uploadSampleContract;
