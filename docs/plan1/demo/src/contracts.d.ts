declare module 'oas:contracts' {
  export interface ReferenceOperation {
    method: string;
    path: string;
    id: string;
    summary: string;
    area: 'business' | 'management' | 'health';
    fields: { name: string; type: string; required: boolean; location: string }[];
    statuses: string[];
    auth: string[];
  }
  const operations: ReferenceOperation[];
  export default operations;
}
