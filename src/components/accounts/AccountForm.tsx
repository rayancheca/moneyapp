"use client";

import { useState } from "react";
import { createAccountAction } from "@/app/accounts/actions";
import { Field, Input, Select } from "@/components/ui/Field";

interface Institution {
  id: string;
  name: string;
}

export function AccountForm({ institutions }: { institutions: Institution[] }) {
  const [type, setType] = useState("checking");
  const isCredit = type === "credit";
  return (
    <form action={createAccountAction} className="grid gap-3 md:grid-cols-2">
      <Field label="Institution">
        <Select name="institutionId" required>
          {institutions.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Account name">
        <Input name="name" required placeholder="Chase Checking" />
      </Field>
      <Field label="Type">
        <Select name="type" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="checking">Checking</option>
          <option value="savings">Savings</option>
          <option value="credit">Credit card</option>
          <option value="investment">Investment</option>
        </Select>
      </Field>
      {type === "investment" ? (
        <Field label="Investment kind">
          <Select name="subtype">
            <option value="brokerage">Brokerage</option>
            <option value="crypto">Crypto</option>
          </Select>
        </Field>
      ) : (
        <Field label="Card / account last 4 (optional)">
          <Input name="last4" placeholder="1234" pattern="\d{4}" />
        </Field>
      )}
      <Field
        label={isCredit ? "Current balance owed (optional)" : "Current balance (optional)"}
        className="md:col-span-2"
      >
        <Input
          name="initialBalance"
          placeholder={isCredit ? "1,240.50 — what you owe today" : "5,230.00"}
          className="figures"
        />
      </Field>
      <div className="md:col-span-2">
        <button
          type="submit"
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface-raised transition-opacity duration-(--duration-fast) hover:opacity-90 active:opacity-80"
        >
          Add account
        </button>
      </div>
    </form>
  );
}
