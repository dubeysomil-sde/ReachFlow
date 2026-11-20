import { HttpClient, provideHttpClient } from '@angular/common/http';
import { ApplicationConfig, inject, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { APP_API, HttpApi, MockApi } from './api';
import { routes } from './app.routes';
import { environment } from '../environments/environment';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(),
    provideRouter(routes),
    {
      provide: APP_API,
      useFactory: () => environment.apiMode === 'MOCK'
        ? new MockApi()
        : new HttpApi(inject(HttpClient)),
    },
  ]
};
