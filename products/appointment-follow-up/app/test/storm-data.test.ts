import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { gunzipSync } from "node:zlib";
import { parseCsv, parseCustomerCsv, toCsv } from "../src/storm/csv.ts";
import { parseGrib2 } from "../src/storm/grib2.ts";
import { parseSpcHailCsv } from "../src/storm/sources.ts";

// A real NOAA MRMS file: MESH 24-hour maximum ending 2025-03-02 12:00 UTC (storm day 2025-03-01).
// Expected values below were read from the same file with ECMWF's eccodes, independently of this decoder.
const fixture = gunzipSync(readFileSync(new URL("./fixtures/mesh-2025-03-01.grib2.gz", import.meta.url)));

describe("GRIB2 hail grid", () => {
  const grid = parseGrib2(fixture);

  it("reads the MRMS CONUS grid", () => {
    assert.equal(grid.ni, 7000);
    assert.equal(grid.nj, 3500);
    assert.ok(Math.abs(grid.lat1 - 54.995) < 1e-9);
    assert.ok(Math.abs(grid.lon1 - 230.005) < 1e-9);
    assert.ok(Math.abs(grid.di - 0.01) < 1e-12);
  });

  it("matches eccodes cell by cell", () => {
    let positive = 0;
    let halfInch = 0;
    let max = 0;
    for (let j = 0; j < grid.nj; j++) {
      for (let i = 0; i < grid.ni; i++) {
        const v = grid.valueAt(i, j);
        if (v > 0) positive++;
        if (v >= 12.7) halfInch++;
        max = Math.max(max, v);
      }
    }
    assert.equal(positive, 5880);
    assert.equal(halfInch, 427);
    assert.ok(Math.abs(max - 61.6) < 1e-6);
  });

  it("finds values by latitude and longitude", () => {
    const cell = (lat: number, lon: number) => {
      const c = grid.cellFor(lat, lon)!;
      return Math.round(grid.valueAt(c.i, c.j) * 10) / 10;
    };
    assert.equal(cell(26.355, -97.605), 61.6);
    assert.equal(cell(26.325, -97.575), 52.0);
    assert.equal(cell(26.335, -97.605), 17.5);
    assert.equal(cell(26.355, -97.575), -1.0, "no-data cells are negative");
  });

  it("takes the largest value in the surrounding cells and ignores no-data", () => {
    assert.equal(Math.round(grid.maxNear(26.355, -97.575) * 10) / 10, 55.4);
    assert.equal(grid.maxNear(45, -100), 0);
    assert.equal(grid.maxNear(10, -100), 0, "outside the grid");
  });

  it("refuses files it can't read", () => {
    assert.throws(() => parseGrib2(new TextEncoder().encode("not a grib file")), /Not a GRIB file/);
  });
});

describe("SPC hail reports", () => {
  it("reads decimal coordinates", () => {
    const csv = "Time,Size,Location,County,State,Lat,Lon,Comments\n1715,175,2 N Hondo,Medina,TX,29.38,-99.14,Golf ball hail. (EWX)\n";
    const [report] = parseSpcHailCsv(csv);
    assert.deepEqual(report, { size: 1.75, location: "2 N Hondo", county: "Medina", state: "TX", lat: 29.38, lon: -99.14 });
  });

  it("reads coordinates without a decimal point or minus sign", () => {
    const [report] = parseSpcHailCsv("Time,Size,Location,County,State,Lat,Lon,Comments\n0530,100,Nowhere,Some,OK,3390,9450,comment, with commas\n");
    assert.equal(report!.lat, 33.9);
    assert.equal(report!.lon, -94.5);
  });

  it("skips headers and junk", () => {
    assert.deepEqual(parseSpcHailCsv("Time,Size,Location\n\nnot,a,report\n"), []);
  });
});

describe("CSV", () => {
  it("parses quotes, commas and newlines inside fields", () => {
    assert.deepEqual(parseCsv('a,b\r\n"1, Oak St","say ""hi""\nthere"\n'), [["a", "b"], ["1, Oak St", 'say "hi"\nthere']]);
  });

  it("writes fields that need quoting", () => {
    assert.equal(toCsv([["a", 'b "c"', "d,e", null, 3]]), 'a,"b ""c""","d,e",,3\r\n');
  });

  it("maps common export headers and checks rows", () => {
    const csv = [
      "First Name,Last Name,E-mail,Phone,Address,City,State,Zip Code,Install Date",
      "Linda,Smith,LINDA@example.com,(555) 010-0101,1418 Mesquite Ln,Abilene,tx,79601-1234,2024-06-02",
      ",,x@example.com,,1 Main,Abilene,TX,79601,",
      "Bob,Jones,not-an-email,,2 Main,Abilene,TX,79601,",
      "Ann,Lee,,,,Abilene,TX,,",
    ].join("\n");
    const { customers, errors } = parseCustomerCsv(csv);
    assert.equal(customers.length, 1);
    assert.deepEqual(customers[0], {
      firstName: "Linda", lastName: "Smith", email: "linda@example.com", phone: "(555) 010-0101",
      street: "1418 Mesquite Ln", city: "Abilene", state: "TX", zip: "79601", jobDate: "2024-06-02",
    });
    assert.deepEqual(errors, ["Row 3: no name.", "Row 4: email “not-an-email” doesn't look right.", "Row 5: needs a street and ZIP."]);
  });

  it("says which columns are missing", () => {
    const { errors } = parseCustomerCsv("name,email\nLinda,l@example.com\n");
    assert.match(errors[0]!, /Missing columns: street, city, state, zip, first_name or last_name/);
  });
});
