import { HttpClient } from '@angular/common/http';
import { AppApi, HttpApi, MockApi } from './api';
import { environment } from '../environments/environment';

export function createAppApi(http: HttpClient): AppApi {
  return environment.apiMode === 'MOCK' ? new MockApi() : new HttpApi(http);
}
