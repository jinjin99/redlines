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
    /** Text it changed that came from the page's data (find_design_edits): change the data or configuration, not the code. */
    data?: DataSource[];
}

export interface DataSource {
    text: string;
    /** The request whose answer held it: 'GET /api/orders'. */
    from: string;
    /** Where in the answer: '[0].customer'. */
    key: string;
    /** false: the data is part of the text (copy around it). */
    whole: boolean;
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
    /** Where clicking goes from this state: { selector: state }. A state whose steps continue another's (same path) is linked from it by itself. */
    links?: Record<string, string>;
}

/** How to run the app, so redlines starts each version itself (capture_change). */
export interface AppConfig {
    /** The app's git checkout, relative to the config. */
    dir: string;
    /** Starts the app: a shell command, run in `dir`, given PORT. */
    start: string;
    /** Run before `start` for each version (a production build). */
    build?: string;
    /** Where the started app answers (default http://localhost:<port>/). */
    url?: string;
    /** Default 3000. */
    port?: number;
    /** The version before a change: a git ref whose meeting point with the working copy is the base (default the remote's default branch). */
    base?: string;
    env?: Record<string, string>;
    /** The app fetches data on the server: run the data proxy replaying the recording, and start the app with its variables. */
    dataProxy?: boolean;
    /** How long to wait for it to answer, in seconds (default 300). */
    timeout?: number;
}

export interface Config {
    baseURL?: string;
    viewport?: { width: number; height: number };
    mocks?: Record<string, MockAnswer>;
    /** A project's MSW handlers answering requests not in `mocks`: the module (relative to the config), or { file, export }. */
    msw?: import('./msw.js').MswConfig;
    /** A recording (record_data) answering what `mocks` and MSW do not: a HAR file, relative to the config. */
    recording?: string;
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
    app?: AppConfig;
    /** Keep which source lines each state ran (<state>.coverage.json), for affected_states; on whenever `app` is set. */
    coverage?: boolean;
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
    /** Where clicking goes from this state: the element's box on the page and the state it leads to. */
    links?: Link[];
    /** The page's text that came from its data (<state>.data.json): text → { from, key }. */
    data?: string;
}

export interface Link {
    to: string;
    selector: string;
    box: Box;
}

export interface Manifest {
    tool: 'redlines';
    version: 1;
    base: string;
    at: string;
    states: ManifestState[];
    /** What was captured (capture_change): the commit, whether it had uncommitted changes, and a fingerprint of the config and data. */
    source?: { commit: string; dirty?: boolean; inputs: string };
}
