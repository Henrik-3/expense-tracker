import { Button, Disclosure, DisclosureButton, DisclosurePanel, Field, Label, Select } from "@headlessui/react";
import type { Category, ItemInput } from "../shared/contracts";
import { Field as TextField } from "./ui";

export type DraftItem = ItemInput & { editKey: string };
const nullable = (value: string) => value.trim() ? value : null;
const fieldNames = {
  description: "Description", productName: "Product name", quantity: "Quantity",
  unit: "Unit", unitPrice: "Unit price", lineTotal: "Line subtotal",
  brand: "Brand", manufacturer: "Manufacturer",
} as const;

export function ReceiptItems({ items, categories, onChange, disabled }: {
  items: DraftItem[];
  categories: Category[];
  onChange: (items: DraftItem[]) => void;
  disabled: boolean;
}) {
  return <div className="line-items">
    {items.map((item, index) => {
      const category = categories.find(category => category.id === item.categoryId);
      const update = (patch: Partial<ItemInput>) => onChange(items.map(row => row.editKey === item.editKey ? { ...row, ...patch } : row));
      return <Disclosure as="article" className="line-item" key={item.editKey} defaultOpen={!item.description}>
        {({ open }) => <>
          <DisclosureButton className="line-item-summary" disabled={disabled}>
            <span className="item-number">{index + 1}</span>
            <span className="item-summary-text">
              <strong>{item.productName || item.description || "New item"}</strong>
              <span>{item.quantity ?? "?"}{item.unit ? ` ${item.unit}` : ""} · {category?.name || (item.categoryId ? "Category unavailable" : "Uncategorized")}{category?.archived ? " (archived)" : ""}</span>
            </span>
            <span className="item-amount">{item.lineTotal ?? "—"}</span>
            <span aria-hidden="true" className="item-chevron">{open ? "−" : "+"}</span>
            <span className="sr-only">{open ? "Collapse" : "Edit"} item {index + 1}</span>
          </DisclosureButton>
          <DisclosurePanel className="line-item-editor">
            <div className="fields">
              {Object.entries(fieldNames).map(([key, name]) => {
                const field = key as keyof typeof fieldNames;
                return <TextField key={field} name={name} value={item[field]}
                  onChange={value => update({ [field]: field === "description" ? value : nullable(value) })} />;
              })}
              <Field className="field">
                <Label>Category</Label>
                <Select value={item.categoryId || ""} onChange={event => update({ categoryId: nullable(event.target.value) })}>
                  <option value="">Uncategorized</option>
                  {categories.filter(category => !category.archived || category.id === item.categoryId).map(category =>
                    <option key={category.id} value={category.id}>{category.name}{category.archived ? " (archived)" : ""}</option>)}
                  {item.categoryId && !category && <option value={item.categoryId}>Current category (unavailable)</option>}
                </Select>
              </Field>
            </div>
            <Button className="quiet" disabled={disabled} onClick={() => onChange(items.filter(row => row.editKey !== item.editKey))}>Remove item {index + 1}</Button>
          </DisclosurePanel>
        </>}
      </Disclosure>;
    })}
  </div>;
}
