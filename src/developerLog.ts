import { Connection } from 'jsforce';

export interface DeveloperLogRecord {
    Id: string;
    Application: string;
    DurationMilliseconds: number;
    Location: string;
    LogLength: number;
    LogUser: {
        Name: string;
    };
    Operation: string;
    Request: string;
    StartTime: string;
    Status: string;
}

export class DeveloperLog {
    public get id(): string { return this.entry.Id; }
    public get application(): string { return this.entry.Application; }
    public get startTime(): Date { return new Date(this.entry.StartTime); }
    public get durationMilliseconds(): number { return this.entry.DurationMilliseconds; }
    public get location(): string { return this.entry.Location; }
    public get size(): number { return this.entry.LogLength; }
    public get user(): string { return this.entry.LogUser.Name; }
    public get operation(): string { return this.entry.Operation; }
    public get request(): string { return this.entry.Request; }
    public get status(): string { return this.entry.Status; }

    constructor(
        private readonly entry: DeveloperLogRecord,
        private readonly connection: Connection
    ) {}

    public async getBody(): Promise<string> {
        const response = await this.connection.tooling.request<string>(`/sobjects/ApexLog/${this.entry.Id}/Body`);
        return response;
    }
} 