/**
 * Shapes mirrored from the API layer's response bodies (src/api/routes/*
 * and src/generation/prompt.ts's Citation). Duplicated here rather than
 * imported directly, since the widget is a separate deployable artifact
 * (a browser bundle) with its own tsconfig/lib target (DOM, no Node
 * types) and must not pull in server-side modules or their dependencies.
 */
export interface Citation {
  index: number;
  chunkId: number;
  publicUrl: string;
  pageNumber: number;
  productRef: string | null;
}

export interface ChatResponseBody {
  answer: string;
  citations: Citation[];
  noContextFound: boolean;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}
