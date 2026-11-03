// The shapes redlines reads and writes: the page tree a capture records, the changes between two of
// them, the config that lists the states, and a captured folder's manifest.

/** [x, y, width, height] in page pixels. */
export type Box = [number, number, number, number];

export interface TreeText {
    text: string;
    box: Box;
}

export interface TreeElement {
    tag: string;
    /** What a person calls it: aria-label, component name, readable class, landmark. */
    name?: string;
    /** React only: the component whose whole output this element is, with its plain props. */
    component?: { name: string; props: Record<string, string | number | boolean> };
    /** Readable classes only, not build hashes. */
    classes?: string[];
    attrs?: Record<string, string>;
    style: Record<string, string>;
    box: Box;
    children?: TreeNode[];
}

export type TreeNode = TreeElement | TreeText;

export interface PageTree {
    version: 1;
    url: string;
    title: string;
    viewport: { width: number; height: number };
    /** The whole page. */
    size: { width: number; height: number };
    state?: { name: string; title: string; path: string };
    root: TreeElement;
}

export type ChangeKind = 'added' | 'removed' | 'changed';

export interface StyleChange {
    who: string;
    property: string;
    was: string | null;
    now: string | null;
}

export interface Change {
    kind: ChangeKind;
    /** The named elements it is in and the text just before it. */
    where: string;
    inside: string[];
    /** What it holds now and held before: components, interactive elements and text. */
    now: string[];
    was: string[];
    /** For a restyle: each property, before and after. */
    styles?: StyleChange[];
    /** One change repeated (a cell in every row). */
    count: number;
    boxes: { before: Box[]; after: Box[] };
}

export type Step =
    | { click: string }
    | { fill: [string, string | { env: string }] }
    | { press: string }
    | { hover: string }
    | { select: [string, string] }
    | { waitFor: string }
    | { wait: number }
    | ((page: import('playwright-core').Page) => unknown);

/** JSON data, { status, json | body, headers }, or a function of the request. */
export type MockAnswer = unknown;

export interface StateConfig {
    path?: string;
    title?: string;
    steps?: Step[];
    mocks?: Record<string, MockAnswer>;
    /** A handler list the MSW module exports, used before its default list (a scenario: `emptyOrders`). */
    msw?: string;
    viewport?: { width: number; height: number };
    settle?: number;
    /** How long each step waits for what it acts on (ms), default 5000. */
    stepTimeout?: number;
    ignore?: string;
}

export interface Config {
    baseURL?: string;
    viewport?: { width: number; height: number };
    mocks?: Record<string, MockAnswer>;
    /** A project's MSW handlers answering requests not in `mocks`: the module (relative to the config), or { file, export }. */
    msw?: import('./msw.js').MswConfig;
    states: Record<string, StateConfig>;
    settle?: number;
    stepTimeout?: number;
    ignore?: string;
    locale?: string;
    timezone?: string;
    /** The time pages see as now (ISO), so dates they work out ("the last 30 days") read the same on every run. */
    now?: string;
    /** false: no standalone HTML per state. */
    html?: boolean;
    /** Where the config was read from. */
    file: string;
}

export interface ManifestState {
    name: string;
    title: string;
    tree: string;
    image: string;
    html?: string;
    fidelity?: number;
}

export interface Manifest {
    tool: 'redlines';
    version: 1;
    base: string;
    at: string;
    states: ManifestState[];
}
