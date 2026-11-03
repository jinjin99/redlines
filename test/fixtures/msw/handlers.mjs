// MSW handlers as a project keeps them: the default list, and a scenario a state can ask for.
import { http, HttpResponse } from 'msw';

export const handlers = [
    http.get('*/api/orders', () =>
        HttpResponse.json([
            { id: '#2001', customer: 'Edsger Dijkstra', status: 'Paid', total: '$12.00' },
            { id: '#2002', customer: 'Barbara Liskov', status: 'Pending', total: '$99.90' },
        ]),
    ),
];

export const empty = [http.get('*/api/orders', () => HttpResponse.json([]))];
