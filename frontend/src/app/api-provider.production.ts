import { HttpClient } from '@angular/common/http';
import { AppApi, HttpApi } from './api';

export function createAppApi(http: HttpClient): AppApi {
  return new HttpApi(http);
}
