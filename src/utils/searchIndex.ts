import type { DatabaseSync } from 'node:sqlite';

/**
 * Full-text search index (SQLite FTS5) over products, customers and sales,
 * kept in sync by triggers. unicode61 with remove_diacritics makes "cafe"
 * match "Café". Each row is one searchable document; a sale has one row for
 * its reference/note plus one per line item, and results are grouped.
 */
export const SEARCH_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  kind UNINDEXED,
  ref_id UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS search_products_ai AFTER INSERT ON products BEGIN
  INSERT INTO search_index (kind, ref_id, title, body)
  VALUES ('product', NEW.id, NEW.name, NEW.sku || ' ' || NEW.category || ' ' || NEW.description);
END;
CREATE TRIGGER IF NOT EXISTS search_products_au AFTER UPDATE ON products BEGIN
  DELETE FROM search_index WHERE kind = 'product' AND ref_id = OLD.id;
  INSERT INTO search_index (kind, ref_id, title, body)
  VALUES ('product', NEW.id, NEW.name, NEW.sku || ' ' || NEW.category || ' ' || NEW.description);
END;
CREATE TRIGGER IF NOT EXISTS search_products_ad AFTER DELETE ON products BEGIN
  DELETE FROM search_index WHERE kind = 'product' AND ref_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS search_customers_ai AFTER INSERT ON customers BEGIN
  INSERT INTO search_index (kind, ref_id, title, body)
  VALUES ('customer', NEW.id, NEW.name,
    COALESCE(NEW.email, '') || ' ' || COALESCE(NEW.phone, '') || ' ' || NEW.notes);
END;
CREATE TRIGGER IF NOT EXISTS search_customers_au AFTER UPDATE ON customers BEGIN
  DELETE FROM search_index WHERE kind = 'customer' AND ref_id = OLD.id;
  INSERT INTO search_index (kind, ref_id, title, body)
  VALUES ('customer', NEW.id, NEW.name,
    COALESCE(NEW.email, '') || ' ' || COALESCE(NEW.phone, '') || ' ' || NEW.notes);
END;
CREATE TRIGGER IF NOT EXISTS search_customers_ad AFTER DELETE ON customers BEGIN
  DELETE FROM search_index WHERE kind = 'customer' AND ref_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS search_sales_ai AFTER INSERT ON transactions BEGIN
  INSERT INTO search_index (kind, ref_id, title, body)
  VALUES ('sale', NEW.id, NEW.reference, NEW.note);
END;
CREATE TRIGGER IF NOT EXISTS search_sales_au AFTER UPDATE OF note ON transactions BEGIN
  DELETE FROM search_index WHERE kind = 'sale' AND ref_id = OLD.id AND title = OLD.reference;
  INSERT INTO search_index (kind, ref_id, title, body)
  VALUES ('sale', NEW.id, NEW.reference, NEW.note);
END;
CREATE TRIGGER IF NOT EXISTS search_items_ai AFTER INSERT ON transaction_items BEGIN
  INSERT INTO search_index (kind, ref_id, title, body)
  VALUES ('sale', NEW.transaction_id, '', NEW.name || ' ' || NEW.sku);
END;
`;

/** Fills the index from existing rows when it is empty (first boot after upgrade). */
export function backfillSearchIndex(db: DatabaseSync): void {
  const empty = !(db.prepare('SELECT 1 FROM search_index LIMIT 1').get() as unknown);
  if (!empty) return;
  db.exec(`
    INSERT INTO search_index (kind, ref_id, title, body)
      SELECT 'product', id, name, sku || ' ' || category || ' ' || description FROM products;
    INSERT INTO search_index (kind, ref_id, title, body)
      SELECT 'customer', id, name, COALESCE(email, '') || ' ' || COALESCE(phone, '') || ' ' || notes FROM customers;
    INSERT INTO search_index (kind, ref_id, title, body)
      SELECT 'sale', id, reference, note FROM transactions;
    INSERT INTO search_index (kind, ref_id, title, body)
      SELECT 'sale', transaction_id, '', name || ' ' || sku FROM transaction_items;
  `);
}

/**
 * Turns free text into a safe FTS5 query: every word must match, each as a
 * prefix ("flat wh" finds "Flat White"). Quoting each token stops FTS5
 * operators (AND, NEAR, *, :) in user input from changing the query.
 */
export function toFtsQuery(input: string): string | null {
  const words = input
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 8);
  if (!words.length) return null;
  return words.map((w) => `"${w.replace(/"/g, '""')}"*`).join(' ');
}
