import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readCiJobBuckets, readCiJobName, readCiJobText } from "./ci-matrix";
import { INTEGRATION_BUCKETS, INTEGRATION_SPECS } from "./integration-buckets";

const INTEGRATION_DIR = join(process.cwd(), "tests/integration");

describe("kosze testów integracyjnych (integration-buckets)", () => {
  it("każdy plik *.test.ts należy do dokładnie jednego kosza", () => {
    // Rekurencyjnie: plik w podkatalogu też musi trafić do kosza, inaczej
    // żaden job CI by go nie uruchomił, a test przeszedłby zielono.
    const onDisk = readdirSync(INTEGRATION_DIR, { recursive: true })
      .map((name) => `tests/integration/${String(name).replaceAll("\\", "/")}`)
      .filter((name) => name.endsWith(".test.ts"))
      .sort();
    expect([...INTEGRATION_SPECS].sort()).toEqual(onDisk);
    expect(new Set(INTEGRATION_SPECS).size).toBe(INTEGRATION_SPECS.length);
    for (const bucket of INTEGRATION_BUCKETS) {
      expect(bucket.length).toBeGreaterThan(0);
    }
  });

  it("matrix CI obejmuje dokładnie kosze INTEGRATION_BUCKETS", () => {
    expect(readCiJobBuckets("integration")).toEqual(INTEGRATION_BUCKETS.map((_, i) => i + 1));
  });

  it("bramka tests czeka na check i kosze integracji i sprawdza ostatnią próbę każdego kosza", () => {
    // Wymagany check `tests` raportuje bramka. Pominięty wymagany job liczy się
    // jako zielony, więc działa także po porażce jobów, a po ponowieniu części
    // koszy sprawdza każdy kosz osobno, nie tylko łączny wynik matrixa.
    expect(readCiJobName("tests")).toBe("tests");
    const gate = readCiJobText("tests");
    expect(gate).toMatch(/^\s+needs: \[check, integration\]\s*$/m);
    expect(gate).toMatch(/^\s+if: \$\{\{ always\(\) \}\}\s*$/m);
    expect(gate).toContain('if [ "$CHECK_RESULT" != "success" ] || [ "$INTEGRATION_RESULT" != "success" ]; then');
    expect(gate).toContain("CHECK_RESULT: ${{ needs.check.result }}");
    expect(gate).toContain("INTEGRATION_RESULT: ${{ needs.integration.result }}");
    // Odczyt jobów runu wymaga uprawnienia i tokenu; filtr musi pasować do nazw koszy.
    expect(gate).toMatch(/^\s+permissions:\s*\n\s+actions: read\s*$/m);
    expect(gate).toContain("GH_TOKEN: ${{ github.token }}");
    expect(gate).toContain("jobs?filter=latest");
    expect(readCiJobName("integration")?.startsWith("integration (")).toBe(true);
    expect(gate).toContain('startswith("integration (")');
    // Pusta lista koszy albo którykolwiek kosz bez sukcesu kończy bramkę porażką.
    expect(gate).toContain("if [ ! -s buckets.txt ] || grep -v '=success$' buckets.txt; then");
  });
});
