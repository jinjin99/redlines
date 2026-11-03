// The same handlers in TypeScript (loaded by Node 22.18+ as it is).
import { http, HttpResponse } from 'msw';

interface Order { id: string; customer: string; status: string; total: string }

const orders: Order[] = [{ id: '#3001', customer: 'Frances Allen', status: 'Paid', total: '$5.00' }];

export const handlers = [http.get('*/api/orders', () => HttpResponse.json(orders))];
