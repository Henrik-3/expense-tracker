import { Field as HeadlessField, Input, Label, Switch } from "@headlessui/react";

export function Field({ name, value, onChange, type = "text" }: {
  name: string;
  value: string | null;
  onChange: (value: string) => void;
  type?: string;
}) {
  return <HeadlessField className="field">
    <Label>{name}</Label>
    <Input type={type} value={value ?? ""} onChange={event => onChange(event.target.value)} />
  </HeadlessField>;
}

export function Toggle({ label, checked, onChange }: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return <HeadlessField className="check">
    <Switch checked={checked} onChange={onChange} className="toggle">
      <span className="toggle-thumb" />
    </Switch>
    <Label>{label}</Label>
  </HeadlessField>;
}

export function ErrorMessage({ error }: { error: unknown }) {
  return error ? <p className="error" role="alert">
    {error instanceof Error ? error.message : typeof error === "string" ? error : "Something went wrong."}
  </p> : null;
}
