// Shopping bag kept in the visitor's browser (localStorage), shared by every page.
// Lines are { id, name, price, img, href, size, sizeLabel, qty }; price may be empty
// while it is unknown, and totals then show the placeholder too.
(() => {
  const KEY = 'anaenby-bag';
  const UNKNOWN = 'xxxxxxxx';
  const listeners = new Set();

  function read() {
    try {
      const items = JSON.parse(localStorage.getItem(KEY));
      return Array.isArray(items) ? items : [];
    } catch (e) {
      return [];
    }
  }

  function write(items) {
    try { localStorage.setItem(KEY, JSON.stringify(items)); } catch (e) { /* storage blocked */ }
    changed();
  }

  function changed() {
    const n = count();
    document.querySelectorAll('[data-bag-count]').forEach((el) => { el.textContent = n; });
    listeners.forEach((fn) => fn());
  }

  const count = () => read().reduce((n, i) => n + i.qty, 0);
  const sameLine = (a, b) => a.id === b.id && a.size === b.size;

  function add(item) {
    const items = read();
    const line = items.find((i) => sameLine(i, item));
    if (line) line.qty += 1;
    else items.push({ ...item, qty: 1 });
    write(items);
  }

  function setQty(index, qty) {
    const items = read();
    if (!items[index]) return;
    if (qty < 1) items.splice(index, 1);
    else items[index].qty = Math.min(qty, 9);
    write(items);
  }

  const remove = (index) => setQty(index, 0);

  const hasPrice = (p) => p !== '' && p != null && !Number.isNaN(Number(p));
  const money = (p) => (hasPrice(p) ? '€ ' + Number(p).toLocaleString('en-US') : UNKNOWN);

  // total is only known when every line has a price
  function subtotal() {
    const items = read();
    if (!items.length) return money(0);
    if (!items.every((i) => hasPrice(i.price))) return UNKNOWN;
    return money(items.reduce((s, i) => s + Number(i.price) * i.qty, 0));
  }

  function subscribe(fn) { listeners.add(fn); }

  // another tab changed the bag
  window.addEventListener('storage', (e) => { if (e.key === KEY) changed(); });
  document.addEventListener('DOMContentLoaded', changed);

  window.Bag = { read, add, setQty, remove, count, money, subtotal, subscribe, UNKNOWN };
})();
