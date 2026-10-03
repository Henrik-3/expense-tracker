import { useState } from "react";
import { Button, Dialog, DialogPanel, DialogTitle, Description, Field as HeadlessField, Fieldset, Label, Select } from "@headlessui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { merchantRuleInputSchema, type MerchantRule } from "../shared/contracts";
import { api, json } from "./api";
import { ErrorMessage, Field } from "./ui";

type RuleInput = Omit<MerchantRule, "id">;
const emptyRule: RuleInput = { matchName: "", merchantName: "", matchType: "prefix" };

function RuleFields({ value, onChange, disabled }: { value: RuleInput; onChange: (value: RuleInput) => void; disabled: boolean }) {
  return <Fieldset className="fields rule-fields" disabled={disabled}>
    <Field name="Printed shop name" value={value.matchName} onChange={matchName => onChange({ ...value, matchName })} />
    <HeadlessField className="field">
      <Label>Match</Label>
      <Select value={value.matchType} onChange={event => onChange({ ...value, matchType: event.target.value as RuleInput["matchType"] })}>
        <option value="prefix">Starts with these words</option>
        <option value="exact">Exact name</option>
      </Select>
    </HeadlessField>
    <Field name="Group as" value={value.merchantName} onChange={merchantName => onChange({ ...value, merchantName })} />
  </Fieldset>;
}

export function MerchantSettings() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ["merchant-rules"], queryFn: () => api<{ rules: MerchantRule[] }>("/merchant-rules") });
  const [value, setValue] = useState<RuleInput>(emptyRule);
  const [editing, setEditing] = useState<MerchantRule | null>(null);
  const [removing, setRemoving] = useState<MerchantRule | null>(null);
  const [validation, setValidation] = useState("");
  const [message, setMessage] = useState("");
  const refresh = () => {
    for (const key of ["merchant-rules", "receipts", "receipt", "stats"]) void qc.invalidateQueries({ queryKey: [key] });
  };
  const save = useMutation({
    mutationFn: ({ id, input }: { id?: string; input: RuleInput }) =>
      api(id ? `/merchant-rules/${id}` : "/merchant-rules", json(input, id ? "PATCH" : "POST")),
    onSuccess: (_, variables) => {
      if (variables.id) setEditing(null);
      else setValue(emptyRule);
      setValidation(""); setMessage("Grouping saved. Existing and future receipts use this rule."); refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/merchant-rules/${id}`, { method: "DELETE" }),
    onSuccess: () => { setRemoving(null); setMessage("Grouping removed. Printed shop names are unchanged."); refresh(); },
  });
  const pending = save.isPending || remove.isPending;
  const submit = (input: RuleInput, id?: string) => {
    const parsed = merchantRuleInputSchema.safeParse(input);
    if (!parsed.success) { setValidation(parsed.error.issues.map(issue => issue.message).join(". ")); return; }
    setValidation(""); setMessage(""); save.mutate({ id, input: parsed.data });
  };
  return <section>
    <h2>Merchant grouping</h2>
    <p className="muted">Keep branch names on receipts and group them together in your ledger and insights. For example, “REWE Viettz ihr Frischemarkt” groups as “REWE”. Changes apply to existing receipts too.</p>
    <p className="muted small">Matching ignores capitalization and extra spaces. Prefixes match whole words, not partial names. Exact rules win, then the longest matching prefix. Other shops stay separate.</p>
    <form className="card rule-form" onSubmit={event => { event.preventDefault(); submit(value); }}>
      <h3>Add grouping rule</h3>
      <RuleFields value={value} onChange={setValue} disabled={pending} />
      <Button type="submit" className="primary" disabled={pending || !value.matchName.trim() || !value.merchantName.trim()}>Add rule</Button>
    </form>
    {!editing && <ErrorMessage error={save.error || validation} />}
    <ErrorMessage error={query.error} />
    {query.error && <Button onClick={() => void query.refetch()}>Retry merchant rules</Button>}
    {query.isPending && <p role="status">Loading merchant rules…</p>}
    {message && <p className="notice" role="status">{message}</p>}
    {query.data?.rules.length === 0 && <div className="empty">No grouping rules. Shops currently use their printed names.</div>}
    <div className="category-list">{query.data?.rules.map(rule => <article className="card rule-row" key={rule.id}>
      <div><strong>{rule.matchName} <span aria-hidden="true">→</span> {rule.merchantName}</strong><p className="muted small">{rule.matchType === "exact" ? "Exact name" : "Starts with these words"}</p></div>
      <div className="actions">
        <Button disabled={pending} onClick={() => { save.reset(); setValidation(""); setEditing(rule); }}>Edit rule</Button>
        <Button className="quiet" disabled={pending} onClick={() => { remove.reset(); setRemoving(rule); }}>Delete rule</Button>
      </div>
    </article>)}</div>
    <Dialog open={editing !== null} onClose={() => { if (!save.isPending) setEditing(null); }} className="dialog">
      <div className="dialog-backdrop" />
      <div className="dialog-position"><DialogPanel className="card dialog-panel">
        <DialogTitle as="h2">Edit merchant rule</DialogTitle>
        <Description>Saving changes grouping for all matching receipts. The printed names stay intact.</Description>
        {editing && <form onSubmit={event => { event.preventDefault(); submit(editing, editing.id); }}>
          <RuleFields value={editing} onChange={input => setEditing({ ...editing, ...input })} disabled={pending} />
          <ErrorMessage error={save.error || validation} />
          <div className="actions"><Button type="submit" className="primary" disabled={save.isPending}>Save rule</Button><Button disabled={save.isPending} onClick={() => setEditing(null)}>Cancel</Button></div>
        </form>}
      </DialogPanel></div>
    </Dialog>
    <Dialog open={removing !== null} onClose={() => { if (!remove.isPending) setRemoving(null); }} className="dialog">
      <div className="dialog-backdrop" />
      <div className="dialog-position"><DialogPanel className="card dialog-panel">
        <DialogTitle as="h2">Delete grouping rule?</DialogTitle>
        <Description>Remove “{removing?.matchName} → {removing?.merchantName}”? Matching receipts will use another applicable rule or their printed shop name. No receipts will be deleted.</Description>
        <ErrorMessage error={remove.error} />
        <div className="actions"><Button className="primary" disabled={remove.isPending} onClick={() => removing && remove.mutate(removing.id)}>Delete grouping</Button><Button disabled={remove.isPending} onClick={() => setRemoving(null)}>Cancel</Button></div>
      </DialogPanel></div>
    </Dialog>
  </section>;
}
