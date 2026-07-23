#!/usr/bin/env node
/**
 * DEPOT/OS smoke test
 * --------------------------------------------------------------
 * Loads the REAL app script out of index.html into a sandboxed
 * Node environment (via `vm`), backed by an in-memory fake
 * Supabase client, and drives it through: CSV import -> stock in
 * -> stock out -> verify totals. This exercises the actual shipped
 * code (parseCSV, importCSVFile, submitStock, fmt, etc.) rather
 * than a hand-written re-implementation, so it catches real
 * regressions in those functions.
 *
 * Usage:
 *   node smoke_test.js [path/to/index.html]
 *
 * Exit code 0 = all checks passed. Non-zero = something broke.
 * Run this after any change to the app before shipping it.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const indexPath = process.argv[2] || path.join(__dirname, "..", "index.html");
const html = fs.readFileSync(indexPath, "utf8");
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const appScript = scripts.sort((a, b) => b.length - a.length)[0]; // the big one is the app
if (!appScript || appScript.length < 5000) {
  console.error("FAIL: could not locate the main app <script> block in", indexPath);
  process.exit(1);
}

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`  ok   - ${label}`);
  } else {
    failures++;
    console.log(`  FAIL - ${label}${detail ? " :: " + detail : ""}`);
  }
}
function section(title) { console.log(`\n${title}`); }

// ---------------------------------------------------------------
// Minimal in-memory fake Supabase client
// ---------------------------------------------------------------
function makeFakeSupabase(store) {
  class FakeQuery {
    constructor(table) { this.table = table; this._filters = []; this._order = null; this._range = null; this._limit = null; this._op = "select"; this._patch = null; }
    select() { return this; }
    eq(col, val) { this._filters.push(r => r[col] === val); return this; }
    or() { return this; }
    order(col) { this._order = col; return this; }
    range(a, b) { this._range = [a, b]; return this; }
    limit(n) { this._limit = n; return this; }
    update(patch) { this._op = "update"; this._patch = patch; return this; }
    delete() { this._op = "delete"; return this; }
    _matchRows() { return store[this.table].filter(r => this._filters.every(f => f(r))); }
    _selectRows() {
      let rows = this._matchRows();
      if (this._order) rows = [...rows].sort((a, b) => (a[this._order] > b[this._order] ? 1 : a[this._order] < b[this._order] ? -1 : 0));
      if (this._range) rows = rows.slice(this._range[0], this._range[1] + 1);
      if (this._limit) rows = rows.slice(0, this._limit);
      return rows;
    }
    _execute() {
      if (this._op === "update") {
        const rows = this._matchRows();
        rows.forEach(r => Object.assign(r, this._patch));
        return { data: rows, error: null };
      }
      if (this._op === "delete") {
        store[this.table] = store[this.table].filter(r => !this._filters.every(f => f(r)));
        return { data: null, error: null };
      }
      return { data: this._selectRows(), error: null };
    }
    then(resolve, reject) { return Promise.resolve(this._execute()).then(resolve, reject); }
    async maybeSingle() { const r = this._selectRows(); return { data: r[0] || null, error: null }; }
    async single() { const r = this._selectRows(); return r[0] ? { data: r[0], error: null } : { data: null, error: { message: "Not found" } }; }
    async upsert(rowsIn, opts) {
      const arr = Array.isArray(rowsIn) ? rowsIn : [rowsIn];
      const conflictCols = ((opts && opts.onConflict) || "id").split(",");
      arr.forEach(nr => {
        const existing = store[this.table].find(r => conflictCols.every(c => r[c] === nr[c]));
        if (existing) Object.assign(existing, nr); else store[this.table].push({ ...nr });
      });
      return { data: arr, error: null };
    }
    async insert(rowsIn) {
      const arr = Array.isArray(rowsIn) ? rowsIn : [rowsIn];
      arr.forEach(r => store[this.table].push({ ...r }));
      return { data: arr, error: null };
    }
  }
  return {
    from(table) { store[table] = store[table] || []; return new FakeQuery(table); },
    channel() { return { on() { return this; }, subscribe() { return this; } }; },
    removeChannel() {},
    rpc: async () => ({ data: null, error: null }),
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      onAuthStateChange: () => {},
      signInWithPassword: async () => ({ data: null, error: { message: "not used in smoke test" } }),
      signUp: async () => ({ data: null, error: { message: "not used in smoke test" } }),
      signOut: async () => ({ error: null }),
    },
  };
}

// ---------------------------------------------------------------
// DOM / browser shim — just enough for the script's top-level
// init and any incidental DOM calls not to throw.
// ---------------------------------------------------------------
function makeFakeElement() {
  const el = {
    style: {}, classList: { add(){}, remove(){}, contains(){ return false; } },
    value: "", textContent: "", innerHTML: "",
    addEventListener(){}, removeEventListener(){}, appendChild(){}, remove(){},
    focus(){}, click(){}, querySelector(){ return null; }, querySelectorAll(){ return []; },
    closest(){ return null; }, setAttribute(){}, getAttribute(){ return null; },
    dataset: {},
  };
  return el;
}

const store = { profiles: [], categories: [], locators: [], inventory: [], sku_locations: [], transactions: [], adjustments: [], login_logs: [], messages: [] };

const sandbox = {};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.console = console;
sandbox.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
sandbox.performance = { now: () => Date.now() };
sandbox.navigator = { userAgent: "smoke-test" };
sandbox.Intl = Intl;
sandbox.requestAnimationFrame = (fn) => setTimeout(fn, 0);
sandbox.setTimeout = setTimeout;
sandbox.clearTimeout = clearTimeout;
sandbox.setInterval = setInterval;
sandbox.clearInterval = clearInterval;
sandbox.window.jspdf = { jsPDF: function () { return { text(){}, save(){}, autoTable(){} }; } };
sandbox.window.supabase = { createClient: () => makeFakeSupabase(store) };
sandbox.document = {
  documentElement: { setAttribute(){}, getAttribute(){ return null; } },
  activeElement: null,
  addEventListener(){}, removeEventListener(){},
  getElementById: () => makeFakeElement(),
  createElement: () => makeFakeElement(),
  querySelector: () => null,
  querySelectorAll: () => [],
  body: makeFakeElement(),
};

vm.createContext(sandbox);
try {
  vm.runInContext(appScript, sandbox, { filename: "app-script.js" });
} catch (err) {
  console.error("FAIL: app script threw while loading:", err.message);
  process.exit(1);
}
// Top-level `let`/`const` bindings (like `state`) live in the context's
// script scope, not on the global object — pull live references out
// explicitly. Since `state` is an object, this is the same underlying
// reference the app's own functions close over, so mutating it here
// (and calling functions retrieved the same way) affects real app state.
for (const name of ["state", "submitStock", "importCSVFile", "parseCSV", "fmt", "getSkuLocations"]) {
  sandbox[name] = vm.runInContext(name, sandbox);
}

// Give the auto-invoked boot() a tick to resolve (it awaits getSession()).
async function main() {
  await new Promise((r) => setTimeout(r, 10));

  section("Fixture setup");
  sandbox.state.session = { id: "u1", name: "Test Admin", username: "testadmin", role: "Admin", status: "online", approved: true };
  sandbox.state.locators = [{ code: "001", zone: "A", description: "" }, { code: "002", zone: "B", description: "" }];
  check("session + locators seeded", !!sandbox.state.session && sandbox.state.locators.length === 2);

  // ---------------------------------------------------------
  // CSV import
  // ---------------------------------------------------------
  section("CSV import (semicolon-delimited, single-quoted, BOM header — matches a real-world export)");
  const csv = "\uFEFF'sku';'description';'category';'locator';'qty';'unit_value';'reorder'\r\n" +
              "10000001;'Test Widget A';'MISC';'001';50;12.5;5\r\n" +
              "10000002;'Test Widget B';'MISC';;30;7.25;3\r\n" +
              "10000001;'Test Widget A (dup row)';'MISC';'001';999;12.5;5\r\n"; // duplicate SKU on purpose
  const fakeFile = { text: async () => csv };
  await sandbox.importCSVFile(fakeFile);
  const inv = sandbox.state.inventory;
  check("2 unique SKUs imported despite 3 CSV rows (dedup)", inv.length === 2, `got ${inv.length}`);
  const a = inv.find(i => i.sku === "10000001");
  check("duplicate row: later row wins", !!a && a.description === "Test Widget A (dup row)", JSON.stringify(a));
  check("qty parsed correctly", !!a && a.qty === 999, `qty=${a && a.qty}`);
  check("unit value parsed correctly", !!a && a.unitValue === 12.5, `unitValue=${a && a.unitValue}`);

  // ---------------------------------------------------------
  // Stock IN across two locations for the same SKU
  // ---------------------------------------------------------
  section("Stock IN — same SKU into two different locations");
  const b = inv.find(i => i.sku === "10000002");
  const qtyBefore = b.qty;
  sandbox.state.stockType = "IN";
  sandbox.state.rows = [
    { sku: "10000002", description: b.description, qty: "10", notes: "", locator: "001" },
    { sku: "10000002", description: b.description, qty: "5", notes: "", locator: "002" },
  ];
  await sandbox.submitStock();
  check("inventory total increased by 15", b.qty === qtyBefore + 15, `qty=${b.qty}, expected ${qtyBefore + 15}`);
  const locs = sandbox.getSkuLocations("10000002");
  const loc001 = locs.find(l => l.locator === "001");
  const loc002 = locs.find(l => l.locator === "002");
  check("location 001 has 10", !!loc001 && loc001.qty === 10, JSON.stringify(loc001));
  check("location 002 has 5", !!loc002 && loc002.qty === 5, JSON.stringify(loc002));
  // Note: this item started with NO locator at all (blank in the CSV), so its
  // original base qty (30) was never attributable to any specific location —
  // only the 15 units moved via this stock-in are location-tracked. That's
  // correct: the system can't invent a location for stock it was never told
  // the location of. Sum-of-locations vs. total is NOT expected to match here.

  // ---------------------------------------------------------
  // Stock OUT — should reduce the correct location only
  // ---------------------------------------------------------
  section("Stock OUT — from a specific location");
  sandbox.state.stockType = "OUT";
  const totalBeforeOut = b.qty;
  sandbox.state.rows = [{ sku: "10000002", description: b.description, qty: "4", notes: "", locator: "001" }];
  await sandbox.submitStock();
  const loc001b = sandbox.getSkuLocations("10000002").find(l => l.locator === "001");
  check("location 001 reduced to 6", !!loc001b && loc001b.qty === 6, JSON.stringify(loc001b));
  check("location 002 untouched (still 5)", sandbox.getSkuLocations("10000002").find(l => l.locator === "002").qty === 5);
  check(`inventory total reduced by 4 (was ${totalBeforeOut}, now ${totalBeforeOut - 4})`, b.qty === totalBeforeOut - 4, `qty=${b.qty}`);

  // ---------------------------------------------------------
  // Seeding path — item that already has a primary location
  // (as opposed to the case above with no locator at all)
  // ---------------------------------------------------------
  section("Stock IN to a NEW location for an item with an existing primary locator (seeding)");
  const aItem = inv.find(i => i.sku === "10000001"); // locator="001", qty=999 from CSV
  const aQtyBefore = aItem.qty;
  sandbox.state.stockType = "IN";
  sandbox.state.rows = [{ sku: "10000001", description: aItem.description, qty: "20", notes: "", locator: "002" }];
  await sandbox.submitStock();
  const aLocs = sandbox.getSkuLocations("10000001");
  const aLoc001 = aLocs.find(l => l.locator === "001");
  const aLoc002 = aLocs.find(l => l.locator === "002");
  check("primary location seeded with original qty", !!aLoc001 && aLoc001.qty === aQtyBefore, JSON.stringify(aLoc001));
  check("new location has the incoming qty", !!aLoc002 && aLoc002.qty === 20, JSON.stringify(aLoc002));
  check("sum of locations equals total for a seeded item", (aLoc001.qty + aLoc002.qty) === aItem.qty, `sum=${aLoc001.qty + aLoc002.qty}, total=${aItem.qty}`);

  // ---------------------------------------------------------
  // Stock OUT — over-withdrawal from an empty/insufficient location must be blocked
  // ---------------------------------------------------------
  section("Stock OUT — guard against over-withdrawal");
  sandbox.state.stockType = "OUT";
  sandbox.state.rows = [{ sku: "10000002", description: b.description, qty: "999", notes: "", locator: "002" }];
  const totalBefore = b.qty;
  await sandbox.submitStock();
  check("over-withdrawal rejected, total unchanged", b.qty === totalBefore, `qty=${b.qty}, expected ${totalBefore}`);

  // ---------------------------------------------------------
  // 5-location cap
  // ---------------------------------------------------------
  section("5-location cap enforcement");
  sandbox.state.stockType = "IN";
  sandbox.state.locators.push({ code: "003" }, { code: "004" }, { code: "005" }, { code: "006" });
  sandbox.state.rows = [
    { sku: "10000002", description: b.description, qty: "1", notes: "", locator: "003" },
    { sku: "10000002", description: b.description, qty: "1", notes: "", locator: "004" },
    { sku: "10000002", description: b.description, qty: "1", notes: "", locator: "005" },
  ];
  await sandbox.submitStock(); // now at 001,002,003,004,005 = 5 locations
  check("SKU now has 5 locations", sandbox.getSkuLocations("10000002").length === 5, `count=${sandbox.getSkuLocations("10000002").length}`);
  sandbox.state.rows = [{ sku: "10000002", description: b.description, qty: "1", notes: "", locator: "006" }];
  await sandbox.submitStock(); // should be rejected — 6th location
  check("6th location rejected", sandbox.getSkuLocations("10000002").length === 5, `count=${sandbox.getSkuLocations("10000002").length}`);

  // ---------------------------------------------------------
  // Timezone
  // ---------------------------------------------------------
  section("Philippine timezone");
  const stamp = sandbox.fmt(0);
  check("fmt() returns YYYY-MM-DD HH:MM shape", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(stamp), stamp);

  // ---------------------------------------------------------
  section("Summary");
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("FAIL: smoke test crashed:", err);
  process.exit(1);
});
