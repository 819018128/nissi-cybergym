/**
 * hive-board-ui — the HOST half of the board's browser view.
 *
 * This half deliberately does almost nothing, and that is the design.
 *
 * The obvious way to build a board UI is to stand up a host Service with Remote
 * methods, have the browser call it, and render the reply. That would mean this
 * package provides a service — which drags in the whole service-provisioning
 * question (an entry-local `isolate` realm, a provider name that must not
 * collide) for a display concern.
 *
 * It is also unnecessary. The board's state ALREADY reaches the browser: every
 * `board_snapshot` call travels through the conversation as a tool result, and
 * the client runtime keeps the frozen result node. So the view can be a pure
 * function of data the turn already holds — no request, no cache, no service,
 * nothing that can go stale or disagree with what the model was told.
 *
 * What this half must do is EXIST. `clientModules` discovers client bundles by
 * scanning the host Loader's entries for packages declaring `dsh.client`, so the
 * package has to be a loader entry — which is what this row in the preset's
 * composition makes it. A host half that contributed nothing at all would work
 * just as well; this one exists so the entry is visible, named, and has a place
 * to grow if a future view genuinely needs a host-side query.
 *
 * See lib/client.js for the browser half.
 */

export const name = 'hive-board-ui'

export function apply(ctx, config) {
  // The client bundle is registered by `@deepseek-ai/dsh-client-modules`, which
  // derives the `dsh.client` entry from this package's own package.json. There
  // is nothing for the host half to wire up.
  void ctx
  void config
}

export default { name, apply }
