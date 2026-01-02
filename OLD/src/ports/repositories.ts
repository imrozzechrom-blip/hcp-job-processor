export interface CallRailCustomerRepo {
  find(query: any): Promise<any[]>;
  findOneAndUpdate(query: any, update: any): Promise<any>;
}

export interface HcpJobRepo {
  findOne(query: any): Promise<any>;
  updateOne(query: any, update: any): Promise<any>;
  save(job: any): Promise<any>;
}

export interface HistoricalAverageRepo {
  findOne(query: any): Promise<any>;
}
