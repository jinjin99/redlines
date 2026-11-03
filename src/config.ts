// The config, checked: a key redlines doesn't know is an error, with the key it most likely meant,
// rather than something that quietly does nothing (`step` for `steps`). Every problem is listed at once.
import { z } from 'zod';

const size = z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict();
const isoDate = z.string().refine(v => !Number.isNaN(new Date(v).getTime()), 'a date, like 2026-11-03T10:00:00Z');

export const stepSchema = z.union([
    z.object({ click: z.string() }).strict(),
    z.object({ fill: z.tuple([z.string(), z.union([z.string(), z.object({ env: z.string() }).strict()])]) }).strict(),
    z.object({ press: z.string() }).strict(),
    z.object({ hover: z.string() }).strict(),
    z.object({ select: z.tuple([z.string(), z.string()]) }).strict(),
    z.object({ waitFor: z.string() }).strict(),
    z.object({ wait: z.number().int().min(0).max(60_000) }).strict(),
    z.function(),
]);

const stateSchema = z
    .object({
        path: z.string().optional(),
        title: z.string().optional(),
        steps: z.array(stepSchema).optional(),
        mocks: z.record(z.unknown()).optional(),
        msw: z.string().optional(),
        viewport: size.optional(),
        settle: z.number().int().min(0).optional(),
        stepTimeout: z.number().int().positive().optional(),
        ignore: z.string().optional(),
    })
    .strict();

export const configSchema = z
    .object({
        baseURL: z.string().url().optional(),
        viewport: size.optional(),
        mocks: z.record(z.unknown()).optional(),
        msw: z.union([z.string(), z.object({ file: z.string(), export: z.string().optional() }).strict()]).optional(),
        recording: z.string().optional(),
        states: z.record(z.string().regex(/^[\w-]+$/, 'letters, digits, - and _ (it names files)'), stateSchema).refine(s => Object.keys(s).length > 0, 'at least one state'),
        settle: z.number().int().min(0).optional(),
        stepTimeout: z.number().int().positive().optional(),
        ignore: z.string().optional(),
        locale: z.string().optional(),
        timezone: z.string().optional(),
        now: isoDate.optional(),
        html: z.boolean().optional(),
    })
    .strict();

/** Edit distance, for "did you mean". */
function distance(a: string, b: string): number {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
}

const known = (at: (string | number)[]): string[] => {
    // An unknown key's neighbours: the keys of the object it is in.
    if (at.length === 0) return Object.keys(configSchema.shape);
    if (at[0] === 'states' && at.length === 2) return Object.keys(stateSchema.shape);
    return [];
};

/** The config's problems, one line each ("states.list.step: unknown key (did you mean steps?)"), or none. */
export function configProblems(config: unknown): string[] {
    const result = configSchema.safeParse(config);
    if (result.success) return [];
    return result.error.issues.flatMap(issue => {
        const where = issue.path.join('.') || '(the config)';
        if (issue.code === 'unrecognized_keys') {
            return issue.keys.map(key => {
                const near = known(issue.path).map(k => [k, distance(key.toLowerCase(), k.toLowerCase())] as const).sort((x, y) => x[1] - y[1])[0];
                const hint = near && near[1] <= Math.max(2, Math.floor(key.length / 3)) ? ` (did you mean ${near[0]}?)` : '';
                return `${issue.path.length ? `${where}.` : ''}${key}: unknown key${hint}`;
            });
        }
        // A step matches one of several shapes: say what a step is, not each shape's complaint.
        if (issue.code === 'invalid_union' && issue.path.includes('steps')) return [`${where}: a step is { click }, { fill: [selector, text] }, { press }, { hover }, { select: [selector, value] }, { waitFor }, { wait: ms } or a function`];
        return [`${where}: ${issue.message}`];
    });
}
