import { HttpClient, provideHttpClient } from '@angular/common/http';
import { ApplicationConfig, inject, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { APP_API } from './api';
import { createAppApi } from './api-provider';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(),
    provideRouter(routes),
    {
      provide: APP_API,
      useFactory: () => createAppApi(inject(HttpClient)),
    },
  ],
};
