// A small React app in two versions (window.VERSION): a card with a badge and buttons.
(function () {
    var h = React.createElement;
    function Badge(props) { return h('span', { className: 'badge badge-' + props.tone }, props.children); }
    function Button(props) { return h('button', { className: 'button' + (props.primary ? ' button-primary' : ''), onClick: props.onClick }, props.children); }
    // What a production build makes of a component's name: two letters, different every build.
    function Xq(props) { return h('div', { className: 'actions' }, props.children); }
    function Card(props) { return h('section', { className: 'card' }, h('h2', null, props.title), props.children); }
    function App() {
        var after = window.VERSION === 'after';
        return h('main', { className: 'page' },
            h(Card, { title: 'Subscription' },
                h('p', null, 'Plan: Pro'),
                h(Badge, { tone: after ? 'success' : 'info' }, after ? 'Active' : 'Trial'),
                h(Xq, null,
                    h(Button, { primary: true }, 'Upgrade'),
                    after ? h(Button, null, 'Cancel plan') : null)));
    }
    ReactDOM.createRoot(document.getElementById('root')).render(h(App));
})();
