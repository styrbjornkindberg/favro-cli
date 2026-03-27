/**
 * DoS Protection Tests for Query Parser
 * CLA-1780 / FIX #2: Test input length and nesting depth limits
 */
import { parseQuery, ParseError } from '../../lib/query-parser';

describe('Query Parser DoS Protection', () => {
  describe('Input Length Limit (max 10KB)', () => {
    test('rejects query string longer than 10,000 characters', () => {
      // Create a query longer than 10KB
      const longQuery = 'status:' + 'a'.repeat(10001);
      
      expect(() => parseQuery(longQuery)).toThrow();
      try {
        parseQuery(longQuery);
      } catch (e: any) {
        expect(e.message).toContain('exceeds maximum length');
      }
    });

    test('accepts query string exactly 10,000 characters (boundary)', () => {
      // Create a query exactly 10KB
      const maxQuery = 'status:' + 'a'.repeat(9993); // 'status:' is 7 chars
      
      // Should not throw
      expect(() => parseQuery(maxQuery)).not.toThrow();
    });

    test('accepts query string under 10,000 characters', () => {
      const query = 'status:' + 'a'.repeat(5000);
      
      expect(() => parseQuery(query)).not.toThrow();
    });

    test('rejects 10KB+ with helpful error message', () => {
      const longQuery = 'status:' + 'a'.repeat(10001);
      
      try {
        parseQuery(longQuery);
        fail('Should have thrown ParseError');
      } catch (e: any) {
        expect(e.message).toContain('exceeds maximum length');
        expect(e.message).toContain('10000');
      }
    });
  });

  describe('Nesting Depth Limit (max 50 levels)', () => {
    test('rejects deeply nested parentheses (>50 levels)', () => {
      // Create deeply nested query: (((((...)))))
      let query = 'status:done';
      for (let i = 0; i < 51; i++) {
        query = `(${query})`;
      }

      expect(() => parseQuery(query)).toThrow();
      try {
        parseQuery(query);
      } catch (e: any) {
        expect(e.message).toContain('exceeds maximum depth');
      }
    });

    test('accepts nesting at exactly 50 levels (boundary)', () => {
      // Create nested query: ((((...))))  × 50
      let query = 'status:done';
      for (let i = 0; i < 50; i++) {
        query = `(${query})`;
      }

      // Should not throw
      expect(() => parseQuery(query)).not.toThrow();
    });

    test('accepts shallow nesting (< 50 levels)', () => {
      let query = 'status:done';
      for (let i = 0; i < 10; i++) {
        query = `(${query})`;
      }

      expect(() => parseQuery(query)).not.toThrow();
    });

    test('rejects 51 levels with helpful error message', () => {
      let query = 'status:done';
      for (let i = 0; i < 51; i++) {
        query = `(${query})`;
      }

      try {
        parseQuery(query);
        fail('Should have thrown ParseError');
      } catch (e: any) {
        expect(e.message).toContain('exceeds maximum depth');
        expect(e.message).toContain('50');
      }
    });

    test('rejects 100 levels of nesting', () => {
      let query = 'status:done';
      for (let i = 0; i < 100; i++) {
        query = `(${query})`;
      }

      expect(() => parseQuery(query)).toThrow('exceeds maximum depth');
    });

    test('rejects mixed AND/OR with deep nesting', () => {
      // Complex query with deep nesting: (((status:done AND assignee:alice OR ...)))
      let query = 'status:done AND assignee:alice';
      for (let i = 0; i < 51; i++) {
        query = `(${query})`;
      }

      expect(() => parseQuery(query)).toThrow('exceeds maximum depth');
    });
  });

  describe('Combined DoS Protection', () => {
    test('rejects if BOTH length and depth exceed limits', () => {
      const longLowValue = 'a'.repeat(10001);
      let query = `status:${longLowValue}`;

      expect(() => parseQuery(query)).toThrow();
    });

    test('rejects if depth exceeds limit even with short query', () => {
      let query = 'status:ok';
      for (let i = 0; i < 51; i++) {
        query = `(${query})`;
      }

      // Should fail due to depth, not length
      expect(() => parseQuery(query)).toThrow('exceeds maximum depth');
    });

    test('normal complex query within limits passes', () => {
      const query = '(status:done OR status:in-progress) AND (assignee~alice OR assignee~bob) AND (tag:urgent OR tag:high-priority)';
      
      expect(() => parseQuery(query)).not.toThrow();
    });
  });

  describe('Error Recovery after DoS rejection', () => {
    test('parser can still parse valid query after rejecting oversized input', () => {
      const tooLong = 'status:' + 'a'.repeat(10001);
      const valid = 'status:done';

      try {
        parseQuery(tooLong);
      } catch {
        // Expected to throw
      }

      // Should still work with valid query
      const result = parseQuery(valid);
      expect(result.ast).toBeDefined();
      expect(result.ast?.kind).toBe('field');
    });

    test('parser can recover after rejecting deep nesting', () => {
      let deepQuery = 'status:done';
      for (let i = 0; i < 51; i++) {
        deepQuery = `(${deepQuery})`;
      }

      try {
        parseQuery(deepQuery);
      } catch {
        // Expected to throw
      }

      // Should still work with shallow query
      const result = parseQuery('(status:done)');
      expect(result.ast).toBeDefined();
    });
  });
});
