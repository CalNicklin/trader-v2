import { describe, expect, test } from "bun:test";
import { extractCodeFromResponse } from "../../src/self-improve/code-generator";

describe("code-generator", () => {
	test("extractCodeFromResponse extracts from typescript code block", () => {
		const response = '```typescript\nconst x = 1;\nconsole.log(x);\n```';
		const result = extractCodeFromResponse(response);
		expect(result).toBe("const x = 1;\nconsole.log(x);");
	});

	test("extractCodeFromResponse extracts from ts code block", () => {
		const response = '```ts\nconst x = 1;\n```';
		const result = extractCodeFromResponse(response);
		expect(result).toBe("const x = 1;");
	});

	test("extractCodeFromResponse returns raw text when no code block", () => {
		const response = "const x = 1;\nconsole.log(x);";
		const result = extractCodeFromResponse(response);
		expect(result).toBe("const x = 1;\nconsole.log(x);");
	});

	test("extractCodeFromResponse returns null for suspiciously short output", () => {
		const response = "x";
		const result = extractCodeFromResponse(response);
		expect(result).toBeNull();
	});
});
