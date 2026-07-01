import crypto from 'crypto';
import type { NetInterest } from '../types';

// Interest classifier: scores an article against Scott's interests
// Uses case-insensitive keyword matching with position-weighted scoring

interface MatchedInterest {
  keyword: string;
  weight: number;
  category: string | null;
}

export class InterestClassifier {
  private interests: NetInterest[];
  private lowercaseKeywords: Map<string, NetInterest>;

  constructor(interests: NetInterest[]) {
    this.interests = interests;
    // Pre-compute lowercase lookup for faster matching
    this.lowercaseKeywords = new Map();
    for (const interest of interests) {
      this.lowercaseKeywords.set(interest.keyword.toLowerCase(), interest);
    }
  }

  /**
   * Score an article's relevance based on keyword matches.
   *
   * Scoring rules:
   * - Title matches are worth 2x weight (more intentional placement)
   * - First match in body gets slight bonus
   * - Multiple matches of same keyword don't stack (one match is enough)
   * - Final score is normalized to 0.0–1.0 range
   */
  score(title: string, body: string | null): {
    score: number;
    matched: string[];
    categories: string[];
  } {
    const text = `${title}\n${body || ''}`.toLowerCase();
    const titleLower = title.toLowerCase();

    const matched: Set<string> = new Set();
    const categories: Set<string> = new Set();
    let rawScore = 0;

    for (const [keyword, interest] of this.lowercaseKeywords) {
      const titleMatch = titleLower.includes(keyword);
      const bodyMatch = body ? text.includes(keyword) : false;

      if (titleMatch || bodyMatch) {
        matched.add(interest.keyword);
        if (interest.category) categories.add(interest.category);

        let matchScore = interest.weight;
        if (titleMatch) matchScore *= 2.0; // Title hits are worth double
        rawScore += matchScore;
      }
    }

    // Normalize: cap at reasonable max, divide to get 0-1 range
    // Max theoretical score if every single keyword matched in title = ~sum(weights * 2)
    // We cap at 5.0 then divide by 5
    const normalized = Math.min(rawScore / 5.0, 1.0);

    return {
      score: Math.round(normalized * 100) / 100,
      matched: Array.from(matched),
      categories: Array.from(categories),
    };
  }

  /**
   * Quick check: does this article score above the threshold to be worth keeping?
   */
  isRelevant(title: string, body: string | null, threshold: number = 0.05): boolean {
    const { score } = this.score(title, body);
    return score >= threshold;
  }
}

/**
 * Generate a SHA-256 content fingerprint for deduplication.
 * Uses URL for URL-level dedup, and title+body for content-level dedup.
 */
export function hashUrl(url: string): string {
  return crypto.createHash('sha256').update(url.trim().toLowerCase()).digest('hex');
}

export function hashContent(title: string, body: string | null): string {
  const content = `${title.trim().toLowerCase()}|${(body || '').substring(0, 500).trim().toLowerCase()}`;
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Clean and truncate a snippet for display.
 */
export function cleanSnippet(text: string | null, maxLength: number = 300): string | null {
  if (!text) return null;
  // Strip HTML tags, collapse whitespace, truncate
  let cleaned = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length > maxLength) {
    cleaned = cleaned.substring(0, maxLength).replace(/\s+\S*$/, '') + '…';
  }
  return cleaned || null;
}
