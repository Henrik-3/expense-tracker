import React, { Component, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button, Fieldset, Legend, Select, Textarea, Tab, TabGroup, TabList, TabPanel, TabPanels } from "@headlessui/react";
import { QueryClient, QueryClientProvider, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { receiptUpdateSchema, type ReceiptDetail, type ReceiptUpdate, type ReceiptListResponse, type Category, type StatsResponse, type Breakdown } from "../shared/contracts";
import { createUploadId } from "./upload-id";
import { api, json, RequestError } from "./api";
import { ErrorMessage, Field, Toggle } from "./ui";
import { ReceiptItems, type DraftItem } from "./receipt-items";
import { MerchantSettings } from "./merchant-settings";
import "./style.css";
import "./components.css";

const client = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 5000 } } });
const busy = (status: string) => status === "queued" || status === "processing";
const label = (status: string) => status.replace("_", " ");
const money = (total: string | null, currency: string | null) => total === null ? "Total not known" : `${currency || "—"} ${total}`;
function useCategories() { return useQuery({ queryKey: ["categories"], queryFn: () => api<{ categories: Category[] }>("/categories") }); }
type Upload = { id: string; name: string; file?: File; url: string; state: "preview" | "uploading" | "failed" | "saved"; error?: string };
function Capture({ open }: { open: (id: string) => void }) {
  const qc = useQueryClient();
  const health = useQuery({ queryKey: ["health"], queryFn: () => api<{ status: string; aiConfigured: boolean }>("/health"), refetchInterval: 30000 });
  const [queue, setQueue] = useState<Upload[]>([]);
  const [notice, setNotice] = useState("");
  const objectUrls = useRef(new Set<string>());
  useEffect(() => () => { objectUrls.current.forEach(url => URL.revokeObjectURL(url)); objectUrls.current.clear(); }, []);
  const [preview, setPreview] = useState(() => { try { return localStorage.getItem("previewCapture") === "true"; } catch { return false; } });
  const update = (id: string, patch: Partial<Upload>) => setQueue(q => q.map(u => u.id === id ? { ...u, ...patch } : u));
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (queue.some(u => u.state !== "saved")) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [queue]);
  async function send(upload: Upload) {
    if (!upload.file) return;
    update(upload.id, { state: "uploading", error: undefined });
    const form = new FormData(); form.append("image", upload.file); form.append("receiptId", upload.id);
    try {
      await api<{ receipt: ReceiptDetail }>("/receipts", { method: "POST", body: form });
      update(upload.id, { state: "saved", file: undefined }); URL.revokeObjectURL(upload.url); objectUrls.current.delete(upload.url);
      void qc.invalidateQueries({ queryKey: ["receipts"] });
    } catch (error) { update(upload.id, { state: "failed", error: error instanceof Error ? error.message : "Upload failed" }); }
  }
  function pick(files: FileList | null) {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) { setNotice(`${file.name}: choose a JPEG, PNG or WebP. HEIC is not supported.`); continue; }
      const upload: Upload = { id: createUploadId(), name: file.name, file, url: URL.createObjectURL(file), state: preview ? "preview" : "uploading" };
      objectUrls.current.add(upload.url);
      setQueue(q => [...q, upload]); if (!preview) void send(upload);
    }
  }
  function remove(upload: Upload) { URL.revokeObjectURL(upload.url); objectUrls.current.delete(upload.url); setQueue(q => q.filter(u => u.id !== upload.id)); }
  return <section>
    {health.data?.aiConfigured === false && <p className="notice" role="status"><strong>Automatic reading is not configured yet.</strong> You can still upload receipts safely. Saved photos will wait in the queue until the server’s AI API key and model are configured. Ask your administrator to complete setup.</p>}
    <ErrorMessage error={health.error} />
    <div className="hero"><div className="eyebrow">LESS ADMIN. MORE LIFE.</div><h1>A little snap.<br />A clearer picture.</h1><p>Capture your receipt. We’ll read the details in the background, so you can get on with your day.</p>
      <div className="actions"><label className="button primary file-button">◎ Take a photo<input aria-label="Take a receipt photo" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={e => { pick(e.target.files); e.target.value = ""; }} /></label>
      <label className="button file-button">↑ Upload receipts<input aria-label="Upload receipt images" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={e => { pick(e.target.files); e.target.value = ""; }} /></label></div>
      <Toggle label="Review photo before uploading" checked={preview} onChange={checked => { setPreview(checked); try { localStorage.setItem("previewCapture", String(checked)); } catch { /* optional preference */ } }} />
      <p className="muted small">JPEG, PNG and WebP · HEIC is not supported. Photos are not stored in browser storage.</p>
    </div>
    {notice && <p className="error" role="alert">{notice}</p>}
    <div className="section-heading"><h2>Your capture queue</h2><span>{queue.length} this session</span></div>
    <p className="muted">Uploading means the file is still on its way. Saved means it is on the server and extraction can continue in the background. Leaving before an upload finishes loses pending local files.</p>
    {!queue.length && <div className="empty"><span className="empty-symbol">▤</span><h3>Ready when you are</h3><p>Your next receipt starts here. Capture one or upload an existing photo.</p></div>}
    <div className="queue">{queue.map(u => <article className="card upload" key={u.id}>
      {u.state !== "saved" && <img src={u.url} alt={`Receipt preview: ${u.name}`} />}
      <div><h3>{u.name}</h3><span className={`badge ${u.state}`}>{u.state === "saved" ? "Saved · background extraction" : u.state === "preview" ? "Awaiting confirmation" : u.state === "uploading" ? "Uploading…" : "Upload failed"}</span>
      {u.error && <p className="error" role="alert">{u.error}</p>}
      <div className="actions">{u.state === "preview" && <Button onClick={() => void send(u)}>Confirm upload</Button>}{u.state === "failed" && <Button onClick={() => void send(u)}>Retry upload</Button>}{u.state === "saved" && <Button onClick={() => open(u.id)}>View receipt</Button>}{u.state !== "uploading" && <Button className="quiet" onClick={() => remove(u)}>{u.state === "saved" ? "Dismiss" : "Discard"}</Button>}</div></div>
    </article>)}</div>
  </section>;
}
function Receipts({ open }: { open: (id: string) => void }) {
  const query = useInfiniteQuery({ queryKey: ["receipts"], initialPageParam: 0, queryFn: ({ pageParam }) => api<ReceiptListResponse>(`/receipts?limit=30&offset=${pageParam}`), getNextPageParam: (last, pages) => { const count = pages.reduce((n, p) => n + p.receipts.length, 0); return count < last.total ? count : undefined; }, refetchInterval: q => q.state.data?.pages.some(p => p.receipts.some(r => busy(r.status))) ? 2500 : false });
  const rows = query.data?.pages.flatMap(p => p.receipts) || [];
  return <section><div className="section-heading"><div><div className="eyebrow">YOUR PAPER TRAIL, SIMPLIFIED</div><h1>Receipts</h1></div><Button onClick={() => void query.refetch()}>Refresh</Button></div><ErrorMessage error={query.error} />
    {query.isPending && <p role="status">Loading receipts…</p>}{!query.isPending && !query.error && !rows.length && <div className="empty"><h2>A clean slate</h2><p>Capture your first receipt to start your ledger.</p></div>}
    <div className="receipt-list">{rows.map(r => <Button className="receipt-row" key={r.id} onClick={() => open(r.id)}><span className="receipt-icon">▤</span><span><strong>{r.merchantGroup || r.merchantName || "Untitled receipt"}</strong>{r.merchantGroup && r.merchantGroup !== r.merchantName && <small>{r.merchantName}</small>}<small>{r.purchasedAt || `Added ${new Date(r.createdAt).toLocaleDateString()}`}<span className={`badge ${r.status}`}>{label(r.status)}</span></small></span><strong>{money(r.total, r.currency)} <span aria-hidden="true">›</span></strong></Button>)}</div>
    {query.hasNextPage && <Button disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? "Loading…" : "Load more"}</Button>}
  </section>;
}
// Keep in-progress text intact (including spaces between words); only blanks become null.
const nullable = (value: string) => value.trim() ? value : null;
type ReceiptDraft = Omit<ReceiptUpdate, "items"> & { items: DraftItem[] };
function draftOf(r: ReceiptDetail): ReceiptDraft { return { revision: r.revision, status: r.status === "ready" ? "ready" : "needs_review", merchantName: r.merchantName, purchasedAt: r.purchasedAt, currency: r.currency, total: r.total, notes: r.notes, items: r.items.map(({ id, ...item }) => ({ ...item, editKey: id })), adjustments: r.adjustments.map(({ id: _id, ...adjustment }) => adjustment) }; }
function Detail({ id, back, onDirty }: { id: string; back: () => void; onDirty: (dirty: boolean) => void }) {
  const qc = useQueryClient(); const cats = useCategories();
  const query = useQuery({ queryKey: ["receipt", id], queryFn: () => api<{ receipt: ReceiptDetail }>(`/receipts/${id}`), refetchInterval: q => q.state.data && busy(q.state.data.receipt.status) ? 2000 : false });
  const [draft, setDraft] = useState<ReceiptDraft | null>(null); const [dirty, setDirty] = useState(false); const [validation, setValidation] = useState(""); const [message, setMessage] = useState("");
  const receipt = query.data?.receipt;
  useEffect(() => { if (receipt && !dirty) setDraft(draftOf(receipt)); }, [receipt, dirty]);
  useEffect(() => { onDirty(dirty); return () => onDirty(false); }, [dirty, onDirty]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const mutation = useMutation({ mutationFn: (value: ReceiptUpdate) => api<{ receipt: ReceiptDetail }>(`/receipts/${id}`, json(value, "PATCH")), onSuccess: result => { setDirty(false); setDraft(draftOf(result.receipt)); qc.setQueryData(["receipt", id], result); void qc.invalidateQueries({ queryKey: ["receipts"] }); void qc.invalidateQueries({ queryKey: ["stats"] }); setMessage(result.receipt.status === "ready" ? "Saved as ready." : "Saved for review. Check any warnings before marking ready."); } });
  const retry = useMutation({ mutationFn: () => api(`/receipts/${id}/retry`, json({})), onSuccess: () => { void query.refetch(); void qc.invalidateQueries({ queryKey: ["receipts"] }); } });
  const edit = (patch: Partial<ReceiptDraft>) => { setDraft(d => d ? { ...d, ...patch } : d); setDirty(true); setMessage(""); };
  function save(status: ReceiptUpdate["status"]) { if (!draft) return; const result = receiptUpdateSchema.safeParse({ ...draft, status }); if (!result.success) { setValidation(result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")); return; } setValidation(""); mutation.mutate(result.data); }
  const locked = !receipt || busy(receipt.status) || mutation.isPending;
  return <section><Button className="quiet" onClick={() => { if (!dirty || window.confirm("Leave without saving your edits?")) back(); }}>← All receipts</Button><h1>Receipt details</h1><ErrorMessage error={query.error} />
    {query.isPending && <p role="status">Loading receipt…</p>}
    {receipt && draft && <><div className="section-heading"><span className={`badge ${receipt.status}`}>{label(receipt.status)}</span><span className="muted">Revision {receipt.revision}{dirty ? " · Unsaved changes" : ""}</span></div>
      {busy(receipt.status) && <p className="notice" role="status">Your receipt is saved. We’re extracting its details in the background. Editing will become available when processing finishes.</p>}
      {receipt.error && <p className="error">{receipt.error}</p>}{receipt.status === "failed" && receipt.revision === 0 && <Button disabled={retry.isPending} onClick={() => retry.mutate()}>Retry extraction</Button>}<ErrorMessage error={retry.error} />
      {!!receipt.warnings.length && <div className="notice"><strong>Review notes</strong><ul>{receipt.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></div>}
      <div className="detail-grid"><aside className="original"><h2>Original receipt</h2><a href={receipt.imageUrl} target="_blank" rel="noreferrer">Open full image ↗</a><img src={receipt.imageUrl} alt="Original uploaded receipt" onError={e => { e.currentTarget.alt = "Receipt image could not load. Use Open full image to retry."; }} /></aside>
      <div><Fieldset as="fieldset" disabled={locked}><Legend as="legend">Receipt information</Legend><div className="fields"><Field name="Shop / merchant" value={draft.merchantName} onChange={v => edit({ merchantName: nullable(v) })} /><Field name="Purchase date" type="date" value={draft.purchasedAt} onChange={v => edit({ purchasedAt: nullable(v) })} /><Field name="Currency (3-letter code)" value={draft.currency} onChange={v => edit({ currency: nullable(v.toUpperCase()) })} /><Field name="Receipt total" value={draft.total} onChange={v => edit({ total: nullable(v) })} /></div>
      <p className="muted small">Saved merchant group: <strong>{receipt.merchantGroup || receipt.merchantName || "Unknown shop"}</strong>. Printed names stay intact; manage grouping in Settings. Shop edits update the group when saved.</p>
      <label className="field">Notes<Textarea value={draft.notes} onChange={e => edit({ notes: e.target.value })} /></label>
      <div className="section-heading"><h2>Line items</h2><span>{draft.items.length} items</span></div><p className="muted small">Expand an item to edit. Leave unknown amounts blank; decimal values are preserved exactly.</p>
      <ReceiptItems items={draft.items} categories={cats.data?.categories || []} disabled={locked} onChange={items => edit({ items })} />
      <ErrorMessage error={cats.error} /><Button onClick={() => edit({ items: [...draft.items, { editKey: createUploadId(), description: "", productName: null, quantity: null, unit: null, unitPrice: null, lineTotal: null, categoryId: null, brand: null, manufacturer: null }] })}>+ Add item</Button>
      <h2>Receipt adjustments</h2><p className="muted small">Discounts use negative amounts; fees use positive amounts.</p>
      {draft.adjustments.map((a, i) => <div className="card editor-card" key={i}><div className="fields"><Field name="Description" value={a.description} onChange={v => edit({ adjustments: draft.adjustments.map((x, j) => j === i ? { ...x, description: v } : x) })} /><label className="field">Kind<Select value={a.kind} onChange={e => edit({ adjustments: draft.adjustments.map((x, j) => j === i ? { ...x, kind: e.target.value as typeof a.kind } : x) })}>{["discount", "fee", "deposit", "rounding", "other"].map(k => <option key={k}>{k}</option>)}</Select></label><Field name="Amount" value={a.amount} onChange={v => edit({ adjustments: draft.adjustments.map((x, j) => j === i ? { ...x, amount: nullable(v) } : x) })} /></div><Button className="quiet" onClick={() => edit({ adjustments: draft.adjustments.filter((_, j) => i !== j) })}>Remove adjustment</Button></div>)}
      <Button onClick={() => edit({ adjustments: [...draft.adjustments, { description: "", kind: "other", amount: null }] })}>+ Add adjustment</Button></Fieldset>
      <ErrorMessage error={mutation.error} />{mutation.error instanceof RequestError && mutation.error.status === 409 && <div className="notice">This receipt changed on the server. Your edits are still here. Copy any changes you want to keep, then <Button onClick={async () => { if (window.confirm("Discard your edits and load the latest version?")) { mutation.reset(); setDirty(false); await query.refetch(); } }}>Refresh latest version</Button>.</div>}
      {mutation.error instanceof RequestError && mutation.error.status === 400 && <p className="notice">Check the details and any discrepancies above, or choose Save · Needs review to keep your edits for later review.</p>}
      {validation && <p className="error" role="alert">{validation}</p>}{message && <p className="notice" role="status">{message}</p>}<div className="actions save"><Button disabled={locked} onClick={() => save("needs_review")}>Save · Needs review</Button><Button className="primary" disabled={locked} onClick={() => save("ready")}>{mutation.isPending ? "Saving…" : "Save · Ready"}</Button></div><p className="muted small">Discrepancies must be resolved before a receipt can be Ready. Save as Needs review to keep unresolved edits.</p></div></div></>}
  </section>;
}
function Categories() {
  const qc = useQueryClient(); const query = useCategories(); const [name, setName] = useState("");
  const mutation = useMutation({ mutationFn: ({ id, name, archived }: { id?: string; name: string; archived?: boolean }) => api(id ? `/categories/${id}` : "/categories", json({ name, archived }, id ? "PATCH" : "POST")), onSuccess: () => { setName(""); void qc.invalidateQueries({ queryKey: ["categories"] }); void qc.invalidateQueries({ queryKey: ["stats"] }); } });
  return <section><h2>Categories</h2><p className="muted">Organize line items your way. Archiving keeps previous assignments intact.</p><form className="card actions" onSubmit={e => { e.preventDefault(); mutation.mutate({ name }); }}><Field name="New category" value={name} onChange={setName} /><Button type="submit" className="primary" disabled={!name.trim() || mutation.isPending}>Create category</Button></form><ErrorMessage error={query.error || mutation.error} />{query.isPending && <p>Loading categories…</p>}{query.data?.categories.length === 0 && <div className="empty">No categories yet. Create one above.</div>}
    <div className="category-list">{query.data?.categories.map(c => <CategoryRow key={`${c.id}-${c.name}-${c.archived}`} category={c} pending={mutation.isPending} save={value => mutation.mutate(value)} />)}</div>
  </section>;
}
function CategoryRow({ category: c, pending, save }: { category: Category; pending: boolean; save: (value: { id: string; name: string; archived?: boolean }) => void }) {
  const [name, setName] = useState(c.name);
  return <form className="card category-row" onSubmit={e => { e.preventDefault(); save({ id: c.id, name }); }}><Field name={c.archived ? "Category (archived)" : "Category name"} value={name} onChange={setName} /><Button type="submit" disabled={pending || !name.trim() || name === c.name}>Rename</Button><Button type="button" className="quiet" disabled={pending} onClick={() => save({ id: c.id, name: c.name, archived: !c.archived })}>{c.archived ? "Unarchive" : "Archive"}</Button></form>;
}
function Settings() {
  return <section><div className="eyebrow">MAKE IT YOURS</div><h1>Settings</h1>
    <TabGroup><TabList className="settings-tabs" aria-label="Settings sections"><Tab>Categories</Tab><Tab>Merchants</Tab></TabList>
      <TabPanels><TabPanel unmount={false}><Categories /></TabPanel><TabPanel unmount={false}><MerchantSettings /></TabPanel></TabPanels>
    </TabGroup>
  </section>;
}
function Bars({ title, rows, currency, basis }: { title: string; rows: Breakdown[]; currency: string; basis: string }) {
  const max = Math.max(...rows.map(r => Math.abs(Number(r.total))), 1);
  return <div className="card chart"><h3>{title}</h3><p className="muted small">{basis}</p>{!rows.length ? <p className="muted">No matching data.</p> : <table><caption className="sr-only">{title}, {currency}, {basis}</caption><thead><tr><th scope="col">Name</th><th scope="col">Total ({currency})</th></tr></thead><tbody>{rows.map((r, i) => <tr key={`${r.name}-${i}`}><th scope="row">{r.name}<span className="bar-track" aria-hidden="true"><span style={{ width: `${Math.abs(Number(r.total)) / max * 100}%` }} /></span></th><td>{r.total}</td></tr>)}</tbody></table>}</div>;
}
function Stats() {
  const cats = useCategories();
  const [filters, setFilters] = useState({ from: "", to: "", groupBy: "month", merchant: "", categoryId: "", brand: "", manufacturer: "", includeNeedsReview: false });
  const params = new URLSearchParams(); Object.entries(filters).forEach(([key, value]) => { if (value !== "" && value !== false) params.set(key, String(value)); });
  const query = useQuery({ queryKey: ["stats", filters], queryFn: () => api<StatsResponse>(`/stats?${params}`) });
  return <section><div className="eyebrow">SEE THE BIGGER PICTURE</div><h1>Spending insights</h1><p className="muted">A clear view of your spending, one currency at a time.</p>
    <div className="card fields filters">{(["from", "to", "merchant", "brand", "manufacturer"] as const).map(k => <Field key={k} name={({ from: "From date", to: "To date", merchant: "Merchant", brand: "Brand", manufacturer: "Manufacturer" })[k]} type={k === "from" || k === "to" ? "date" : "text"} value={filters[k]} onChange={v => setFilters(f => ({ ...f, [k]: v }))} />)}<label className="field">Group timeline by<Select value={filters.groupBy} onChange={e => setFilters(f => ({ ...f, groupBy: e.target.value }))}>{["day", "week", "month"].map(v => <option key={v}>{v}</option>)}</Select></label><label className="field">Category<Select value={filters.categoryId} onChange={e => setFilters(f => ({ ...f, categoryId: e.target.value }))}><option value="">All categories</option>{cats.data?.categories.map(c => <option key={c.id} value={c.id}>{c.name}{c.archived ? " (archived)" : ""}</option>)}</Select></label><Toggle label="Include Needs review" checked={filters.includeNeedsReview} onChange={checked => setFilters(f => ({ ...f, includeNeedsReview: checked }))} /></div>
    <ErrorMessage error={query.error || cats.error} />{query.error && <Button onClick={() => void query.refetch()}>Retry insights</Button>}{query.isFetching && <p role="status">Updating insights…</p>}
    {query.data && <><p className="notice">{query.data.excludedReceipts} incomplete receipt{query.data.excludedReceipts === 1 ? "" : "s"} excluded. Category, brand and manufacturer breakdowns always use line subtotals; receipt discounts are not allocated to items.</p>{!query.data.currencies.length && <div className="empty"><h2>No spending to show yet</h2><p>Save complete receipts as Ready, or adjust your filters.</p></div>}{query.data.currencies.map(c => <section key={c.currency} className="currency-section"><div className="stat-summary"><div><span className="eyebrow">{c.currency} · {c.basis === "items" ? "LINE SUBTOTAL BASIS" : "RECEIPT TOTAL BASIS"}</span><h2>{c.total} <small>{c.currency}</small></h2></div><span>{c.receiptCount} receipts</span></div><div className="charts"><Bars title="Over time" rows={c.timeline} currency={c.currency} basis={c.basis === "receipts" ? "Receipt totals" : "Filtered item subtotals"} /><Bars title="By shop" rows={c.merchants} currency={c.currency} basis={c.basis === "receipts" ? "Receipt totals" : "Filtered item subtotals"} /><Bars title="By category" rows={c.categories} currency={c.currency} basis="Line subtotals · no receipt discount allocation" /><Bars title="By brand" rows={c.brands} currency={c.currency} basis="Line subtotals · no receipt discount allocation" /><Bars title="By manufacturer" rows={c.manufacturers} currency={c.currency} basis="Line subtotals · no receipt discount allocation" /></div></section>)}</>}
  </section>;
}
class Boundary extends Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <main><h1>We couldn’t display this page.</h1><p>Your saved receipts are still on the server. Reload to try again. Pending local uploads may be lost.</p><Button onClick={() => location.reload()}>Reload application</Button></main> : this.props.children; }
}
function App() {
  const [page, setPage] = useState("capture"); const [id, setId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  function navigate(next: string) { if (dirty && !window.confirm("Leave without saving your edits?")) return; setPage(next); setId(null); }
  return <><header><a className="logo" href="#capture" onClick={e => { e.preventDefault(); navigate("capture"); }}><span aria-hidden="true">▤</span> receipt<span className="logo-light">ledger</span></a><span className="header-note">Small receipts. Big clarity.</span></header><div className="layout"><nav aria-label="Main navigation">{[["capture", "◎", "Capture"], ["receipts", "▤", "Receipts"], ["stats", "▥", "Insights"], ["settings", "⊞", "Settings"]].map(([key, icon, title]) => <Button key={key} className={page === key ? "active" : ""} aria-current={page === key ? "page" : undefined} onClick={() => navigate(key)}><span aria-hidden="true">{icon}</span>{title}</Button>)}<p className="nav-note">Your everyday spending,<br />thoughtfully organized.</p></nav><main>
    <div hidden={page !== "capture" || id !== null}><Capture open={value => { setPage("receipts"); setId(value); }} /></div>
    {page === "receipts" && (id ? <Detail key={id} id={id} back={() => setId(null)} onDirty={setDirty} /> : <Receipts open={setId} />)}{page === "stats" && <Stats />}{page === "settings" && <Settings />}
    <footer>Receipt Ledger · Keep the details. Lose the paperwork.</footer></main></div></>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><Boundary><QueryClientProvider client={client}><App /></QueryClientProvider></Boundary></React.StrictMode>);
