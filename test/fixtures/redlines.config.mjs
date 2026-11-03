// The fixture app's states: its list, and the details dialog a click opens (so the list links to it
// by itself); the dialog's Close leads back. Orders come from a mock.
export default {
    viewport: { width: 1024, height: 700 },
    mocks: {
        'GET /api/orders': [
            { id: '#1001', customer: 'Ada Lovelace', status: 'Paid', total: '$120.00' },
            { id: '#1002', customer: 'Alan Turing', status: 'Pending', total: '$45.50' },
            { id: '#1003', customer: 'Grace Hopper', status: 'Paid', total: '$310.20' },
        ],
    },
    states: {
        list: { path: '/index.html', title: 'Order list' },
        details: { path: '/index.html', title: 'Order details dialog', steps: [{ click: 'text=#1001' }], links: { '#close': 'list' } },
    },
};
