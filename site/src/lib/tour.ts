/*
 * The landing page's camera tour: one entry per scroll step, in tour order.
 * The chip row in `FactoryScene.astro` and the `data-tour-step` sections in
 * `index.astro` both derive from this list, so they can never drift apart.
 * All framing lives here: `zoom` and `offset` are handed to `focusOn()` in
 * the vendored `factory-view.js`, keyed by step index (which is why tape + QA
 * appears twice — the opening close-up and the rework-loop stop).
 */
export interface Shot {
  /** `focusOn` element id: 'home' | 'feeder' | 'machine-N' | 'rocket'. */
  id: string;
  label: string;
  /**
   * Zoom at focus (1 = the API's default full-line framing). The overview is
   * the exception: its zoom is recomputed at boot to fit the line across the
   * container's actual aspect, so here it is the landscape cap.
   */
  zoom: number;
  /**
   * Where the subject lands on screen: `focusOn`'s percent offset from the
   * viewport centre (+y down). The shots sit below centre, in the band under
   * the hero copy; `yPortrait` overrides `y` on portrait containers.
   */
  offset: { x: number; y: number; yPortrait?: number };
}

export const shots: Shot[] = [
  { id: "machine-2", label: "Welcome", zoom: 2.5, offset: { x: 0, y: 30 } },
  { id: "home", label: "Workflow", zoom: 1, offset: { x: -15, y: 0, yPortrait: 34 } },
  { id: "feeder", label: "Dispatch", zoom: 1.8, offset: { x: -25, y: -15 } },
  { id: "machine-1", label: "Agents", zoom: 2.5, offset: { x: -20, y: 8 } },
  { id: "machine-2", label: "Validation", zoom: 2.5, offset: { x: -10, y: 8 } },
  { id: "rocket", label: "Ship", zoom: 1.8, offset: { x: -10, y: 15 } },
];
