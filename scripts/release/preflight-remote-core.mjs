// preflight-remote-core.mjs — the preflight's shared primitives, in one place so the guard module and
// the driver can both import them without a cycle.
//
// It exists because the caps forced a split and a cycle-free split needs a leaf: after five review
// rounds the driver reached the 400-line cap, and the guards were the block that had grown most. This
// module holds only what BOTH halves need.
//
// Dependency-free, Node >= 22. No side effects on import.

export const EXIT = Object.freeze({ ok: 0, usage: 2, refusal: 3, inconclusive: 9 });

// The destination is the dispatcher's own pair — dispatch-publish.mjs defaults `ref: 'main'` and
// hardcodes the remote as `origin`. Nothing is derived from git config: an earlier draft resolved
// {remote, branch} from branch.<name>.merge / pushRemote / remote.pushDefault, and under
// push.default=current that derivation can differ from origin/<ref>, so the guard would pass while
// the preflight verified a different ref.
export const REMOTE = 'origin';
export const DEFAULT_REF = 'main';

export const fail = (exitCode, message) => Object.assign(new Error(message), { exitCode });

export const firstLine = (text) => String(text ?? '').trim().split('\n')[0].trim();
