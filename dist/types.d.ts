export interface IHcpJob {
    id: string;
    created_at: string;
    updated_at?: string;
    completed_at?: string;
    customer?: {
        id?: string;
        first_name?: string;
        last_name?: string;
        email?: string;
        mobileNumber?: string;
        homeNumber?: string;
        phone?: string;
        [key: string]: any;
    };
    address?: any;
    work_status?: string;
    total_amount?: number;
    assigned_employees?: any[];
    schedule?: any;
    job_fields?: any;
    [key: string]: any;
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
export interface IHistoricalAverage {
    overallAverageRevenue: number;
    sourceAverages: Record<string, number>;
    subSourceAverages: Record<string, number>;
    date: Date;
    companyId: string;
    [key: string]: any;
}
