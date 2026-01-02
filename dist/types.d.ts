export interface IHcpJob {
    id: string;
    total_amount: number;
    created_at: Date;
    completed_at?: Date | null;
}
export interface ICompany {
    _id: string;
    timezone: string;
}
export interface JobComponent {
    hcpId: string;
    revenue?: number;
    jobStatus?: "created" | "completed" | "canceled";
    created_at?: Date;
    updated_at?: Date;
    completed_at?: Date | null;
    schedule?: {
        scheduled_start?: string | Date;
    };
    customer?: any;
    assigned_employees?: any;
    jobCategory?: string;
    jobType?: string;
}
export interface ParentJob {
    jobStatus?: string;
    schedule?: any;
    completed_at?: Date | null;
    customer?: any;
    assigned_employees?: any;
    jobCategory?: string;
    jobType?: string;
    created_at?: Date;
    updated_at?: Date;
    jobComponents: JobComponent[];
}
