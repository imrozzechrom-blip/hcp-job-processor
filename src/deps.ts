// src/deps.ts

export interface JobProcessorDeps {
  CallRailCustomer: {
    findOneAndUpdate: (query: any, update: any) => Promise<any>;
    find: (query: any) => Promise<any[]>;
  };

  HcpJob: {
    findOne: (query: any) => Promise<any>;
    updateOne: (query: any, update: any) => Promise<any>;
    save: (doc: any) => Promise<any>;
  };

  HistoricalAverage: {
    findOne: (query: any) => Promise<any>;
  };

  calculateLostRevenueInJob: (...args: any[]) => any;
  findBestCallrailCustomer: (...args: any[]) => any;
  getLatLonFromGeocode: (...args: any[]) => any;
}
