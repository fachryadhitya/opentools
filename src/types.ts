export type DirectoryPerson = {
  id: string;
  name: string;
  description?: string;
  url: string;
  tags: string[];
  country?: string;
  twitter?: string;
  emoji?: string;
  computer?: string;
  phone?: string;
};

export type ContextChunk = {
  chunkId: number;
  personId: string;
  personName: string;
  profileUrl: string;
  pageUrl: string;
  chunkText: string;
};
