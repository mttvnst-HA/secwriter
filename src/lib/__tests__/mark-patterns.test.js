import { describe, it, expect } from "vitest";
import { detectPatterns } from "../mark-patterns.js";

describe("detectPatterns", () => {
  describe("RID detection", () => {
    it("detects ASTM standards", () => {
      const text = "Conform to ASTM D2487 for classification.";
      const results = detectPatterns(text, text);
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe("rid");
      expect(results[0].text).toBe("ASTM D2487");
    });

    it("detects ASTM with dual designation", () => {
      const text = "Per ASTM C33/C33M for fine aggregate.";
      const results = detectPatterns(text, text);
      expect(results).toHaveLength(1);
      expect(results[0].text).toBe("ASTM C33/C33M");
    });

    it("detects AASHTO standards", () => {
      const text = "Testing per AASHTO T99 method.";
      const results = detectPatterns(text, text);
      expect(results).toHaveLength(1);
      expect(results[0].text).toBe("AASHTO T99");
    });

    it("detects AWWA standards", () => {
      const text = "Install per AWWA C600 requirements.";
      const results = detectPatterns(text, text);
      expect(results).toHaveLength(1);
      expect(results[0].text).toBe("AWWA C600");
    });

    it("detects multiple RID in same text", () => {
      const text = "Use ASTM D698 or ASTM D1557 methods.";
      const results = detectPatterns(text, text);
      expect(results).toHaveLength(2);
      expect(results[0].text).toBe("ASTM D698");
      expect(results[1].text).toBe("ASTM D1557");
    });

    it("detects ACI standards", () => {
      const text = "Design per ACI 318.";
      const results = detectPatterns(text, text);
      expect(results).toHaveLength(1);
      expect(results[0].text).toBe("ACI 318");
    });

    it("detects NFPA standards", () => {
      const text = "Comply with NFPA 70.";
      const results = detectPatterns(text, text);
      expect(results).toHaveLength(1);
      expect(results[0].text).toBe("NFPA 70");
    });

    it("detects UFC references", () => {
      const text = "See UFC 1-300-02 for format.";
      const results = detectPatterns(text, text);
      expect(results).toHaveLength(1);
      expect(results[0].text).toBe("UFC 1-300-02");
    });

    it("skips already-marked RID in HTML", () => {
      const text = "Conform to ASTM D2487 for classification.";
      const html = 'Conform to <span class="mark-rid">ASTM D2487</span> for classification.';
      const results = detectPatterns(text, html);
      expect(results).toHaveLength(0);
    });

    it("returns correct positions", () => {
      const text = "Use ASTM D698 method.";
      const results = detectPatterns(text, text);
      expect(results[0].start).toBe(4);
      expect(results[0].end).toBe(13);
      expect(text.substring(results[0].start, results[0].end)).toBe("ASTM D698");
    });
  });

  describe("SRF detection", () => {
    it("detects section numbers", () => {
      const text = "See Section 01 33 00 SUBMITTAL PROCEDURES.";
      const results = detectPatterns(text, text);
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe("srf");
      expect(results[0].text).toBe("01 33 00");
    });

    it("detects multiple section numbers", () => {
      const text = "Sections 32 92 19 through 32 92 26 apply.";
      const results = detectPatterns(text, text);
      expect(results).toHaveLength(2);
      expect(results[0].text).toBe("32 92 19");
      expect(results[1].text).toBe("32 92 26");
    });

    it("skips already-marked SRF", () => {
      const text = "Section 01 33 00 applies.";
      const html = 'Section <span class="mark-srf">01 33 00</span> applies.';
      const results = detectPatterns(text, html);
      expect(results).toHaveLength(0);
    });
  });

  describe("edge cases", () => {
    it("returns empty for empty text", () => {
      expect(detectPatterns("", "")).toEqual([]);
      expect(detectPatterns(null, null)).toEqual([]);
    });

    it("returns empty for text with no patterns", () => {
      const text = "This is a plain paragraph with no standards.";
      expect(detectPatterns(text, text)).toEqual([]);
    });

    it("handles mixed RID and SRF in same text", () => {
      const text = "Per ASTM D2487 and Section 01 33 00 requirements.";
      const results = detectPatterns(text, text);
      const rids = results.filter(r => r.type === "rid");
      const srfs = results.filter(r => r.type === "srf");
      expect(rids).toHaveLength(1);
      expect(srfs).toHaveLength(1);
    });

    it("does not match partial words", () => {
      const text = "The CUSTARD2487 is not a standard.";
      const results = detectPatterns(text, text);
      expect(results).toHaveLength(0);
    });

    it("skips text already marked with a different mark type", () => {
      const text = "Adhere to UFC 1-300-02 format standard.";
      const html = 'Adhere to <span class="mark-url">UFC 1-300-02</span> format standard.';
      const results = detectPatterns(text, html);
      expect(results).toHaveLength(0);
    });
  });
});
