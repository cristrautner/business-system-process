// CSV in (customer import) and out (Smartpress mailing lists).

/** Parses CSV with quoted fields, doubled quotes and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const input = text.replace(/^﻿/, "");
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === "") {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((value) => value.trim() !== ""));
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const cell = (value: string | number | null | undefined) => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}

export interface ImportedCustomer {
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  street: string;
  city: string;
  state: string;
  zip: string;
  jobDate: string | null;
}

const HEADERS: Record<keyof ImportedCustomer, string[]> = {
  firstName: ["firstname", "first", "fname", "givenname"],
  lastName: ["lastname", "last", "lname", "surname", "familyname"],
  email: ["email", "emailaddress", "e-mail"],
  phone: ["phone", "phonenumber", "mobile", "cell", "telephone"],
  street: ["street", "address", "address1", "streetaddress", "addressline1", "propertyaddress"],
  city: ["city", "town"],
  state: ["state", "st", "province"],
  zip: ["zip", "zipcode", "postalcode", "postcode", "zip5"],
  jobDate: ["jobdate", "installdate", "date", "completed", "completeddate", "jobcompleted"],
};

const normalize = (header: string) => header.toLowerCase().replace(/[^a-z0-9-]/g, "");

/** Turns a customer CSV into rows the app can store. Row numbers in errors count the header as row 1. */
export function parseCustomerCsv(text: string): { customers: ImportedCustomer[]; errors: string[] } {
  const rows = parseCsv(text);
  const errors: string[] = [];
  if (rows.length < 2) return { customers: [], errors: ["The file needs a header row and at least one customer."] };

  const header = rows[0]!.map(normalize);
  const column = {} as Record<keyof ImportedCustomer, number>;
  for (const [key, names] of Object.entries(HEADERS) as [keyof ImportedCustomer, string[]][]) {
    column[key] = header.findIndex((h) => names.includes(h) || h === normalize(key));
  }
  const missing: string[] = (["street", "city", "state", "zip"] as const).filter((key) => column[key] < 0);
  if (column.firstName < 0 && column.lastName < 0) missing.push("first_name or last_name");
  if (missing.length) {
    return { customers: [], errors: [`Missing columns: ${missing.join(", ")}. Expected first_name, last_name, email, phone, street, city, state, zip, job_date.`] };
  }

  const customers: ImportedCustomer[] = [];
  rows.slice(1).forEach((row, index) => {
    const get = (key: keyof ImportedCustomer) => (column[key] >= 0 ? (row[column[key]] ?? "").trim() : "");
    const customer: ImportedCustomer = {
      firstName: get("firstName"),
      lastName: get("lastName"),
      email: get("email").toLowerCase() || null,
      phone: get("phone") || null,
      street: get("street"),
      city: get("city"),
      state: get("state").toUpperCase(),
      zip: get("zip").replace(/^(\d{5})-?\d{4}$/, "$1"),
      jobDate: get("jobDate") || null,
    };
    const rowNumber = index + 2;
    if (!customer.firstName && !customer.lastName) errors.push(`Row ${rowNumber}: no name.`);
    else if (!customer.street || !customer.zip) errors.push(`Row ${rowNumber}: needs a street and ZIP.`);
    else if (customer.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(customer.email)) errors.push(`Row ${rowNumber}: email “${customer.email}” doesn't look right.`);
    else customers.push(customer);
  });
  return { customers, errors };
}
