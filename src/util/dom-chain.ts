/**
 * Walking up out of a shadow root.
 *
 * `parentElement` stops dead at the edge of a shadow root, and Home Assistant
 * puts one between a card and the view that holds it — so every walk that has
 * to reach the dashboard needs this. Each element is yielded exactly once: the
 * obvious version, which steps to the shadow root and then to its host, visits
 * the host twice, which is invisible in a search and wrong in a sum.
 */
export function* ancestorsAcrossShadow(start: Node, max = 16): Generator<HTMLElement> {
  let node: Node | null = start;
  for (let hops = 0; node && hops < max; hops += 1) {
    if (node instanceof HTMLElement) yield node;
    const parent: Node | null = node.parentNode;
    node = parent instanceof ShadowRoot ? parent.host : parent;
  }
}
