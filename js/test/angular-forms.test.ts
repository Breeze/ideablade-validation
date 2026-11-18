// @vitest-environment jsdom
// Template-driven forms and signal entity stores, with TestBed. JIT links the directives' partial declarations at runtime.
import '@angular/compiler';
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { FormsModule, NgModel } from '@angular/forms';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';
import { By } from '@angular/platform-browser';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ValidationFormsDirectives, ValidationService, provideValidation, signalEntityStore } from '../src/angular/index.js';
import type { ValidationError } from '../src/core/validation-error.js';
import { asyncValidator } from '../src/index.js';

const metadata = {
  Customer: {
    properties: {
      name: { displayName: 'Name', required: true, maxLength: 5 },
      login: { displayName: 'Login', validators: [{ name: 'available', async: true }] },
      code: { displayName: 'Code', validators: [{ group: 'submit', validators: ['required'] }] },
    },
  },
  Note: {
    properties: { text: { displayName: 'Text', required: true } },
  },
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class Host {
  customer: Record<string, unknown> = { name: '', login: 'free', code: '', nick: '' };
  note = { text: '' };
  // A plain object whose type a custom resolver recognizes.
  tagged = { kind: 'Note', text: '' };
  group: string | undefined = undefined;
  noModel = { name: '' };
}

const TestHost = Component({
  selector: 'test-host',
  imports: [FormsModule, ValidationFormsDirectives],
  template: `
    <form [validationModel]="customer" validationModelType="Customer" [validationGroup]="group">
      <input name="name" [(ngModel)]="customer['name']" />
      <input name="login" [(ngModel)]="customer['login']" />
      <input name="code" [(ngModel)]="customer['code']" />
      <input name="nick" [(ngModel)]="customer['nick']" validationPropertyName="name" />
    </form>
    <input name="text" [(ngModel)]="note.text" [validationModel]="note" validationModelType="Note" />
    <input name="taggedText" [(ngModel)]="tagged.text" [validationModel]="tagged" validationPropertyName="text" />
    <form><input name="unvalidated" [(ngModel)]="noModel.name" /></form>
  `,
})(Host);

beforeAll(() => {
  TestBed.initTestEnvironment(BrowserTestingModule, platformBrowserTesting());
});

describe('Template-driven forms', () => {
  let fixture: ComponentFixture<Host>;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [TestHost],
      providers: [
        provideZonelessChangeDetection(),
        provideValidation({
          metadata,
          modelTypeResolvers: [(model) => (model as { kind?: string } | null)?.kind],
          validators: [asyncValidator('available', (login) => Promise.resolve(login !== 'taken'), '%displayName% is taken')],
        }),
      ],
    });
    fixture = TestBed.createComponent(TestHost);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  const control = (name: string) =>
    fixture.debugElement.queryAll(By.directive(NgModel)).map((d) => d.injector.get(NgModel)).find((m) => m.name === name)!.control;
  const messages = (name: string) => Object.values(control(name).errors ?? {}).map((e) => (e as ValidationError).errorMessage);
  const type = async (name: string, value: string) => {
    const input = fixture.debugElement.query(By.css(`input[name="${name}"]`)).nativeElement as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();
  };

  it('validates each ngModel with the rules of its property, using the form model', async () => {
    expect(messages('name')).toEqual(['Name is required']);
    await type('name', 'Too long');
    expect(messages('name')).toEqual(['Name must be at most 5 characters']);
    await type('name', 'Ann');
    expect(control('name').valid).toBe(true);
  });

  it('errors are ValidationErrors keyed by error key', () => {
    const errors = control('name').errors!;
    expect(Object.keys(errors)).toEqual(['required_name']);
    expect((errors['required_name'] as ValidationError).propertyName).toBe('name');
  });

  it('runs async rules as an async validator', async () => {
    await type('login', 'taken');
    expect(control('login').pending).toBe(true);
    await delay(400);
    expect(messages('login')).toEqual(['Login is taken']);
    await type('login', 'other');
    await delay(400);
    expect(control('login').valid).toBe(true);
  });

  it('validationPropertyName overrides the control name', () => {
    expect(messages('nick')).toEqual(['Name is required']);
  });

  it('a field can bring its own model and type', async () => {
    expect(messages('text')).toEqual(['Text is required']);
    await type('text', 'hello');
    expect(control('text').valid).toBe(true);
  });

  it('resolves the model type with the registered resolvers', async () => {
    expect(messages('taggedText')).toEqual(['Text is required']);
    await type('taggedText', 'hello');
    expect(control('taggedText').valid).toBe(true);
  });

  it('does nothing without a model', () => {
    expect(control('unvalidated').valid).toBe(true);
  });

  it('re-validates when the form inputs change', async () => {
    expect(control('code').valid).toBe(true);
    fixture.componentInstance.group = 'submit';
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(messages('code')).toEqual(['Code is required']);
    // Rules without a group don't run for the 'submit' group.
    expect(control('name').valid).toBe(true);
  });
});

describe('signalEntityStore', () => {
  it('re-validates when a signal changes, once per change', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection(), provideValidation({ metadata })] });
    const notes = signal([{ text: 'a' }]);
    let reads = 0;
    const store = TestBed.runInInjectionContext(() =>
      signalEntityStore(() => {
        reads++;
        return notes().map((entity) => ({ entityType: 'Note', entity }));
      }),
    );
    const results: string[][] = [];
    const sub = TestBed.inject(ValidationService)
      .validateEntityStore(store)
      .subscribe((r) => results.push(r.validationErrors.map((e) => e.errorMessage)));
    TestBed.tick();
    expect(results).toEqual([[]]);

    notes.set([{ text: 'a' }, { text: '' }]);
    TestBed.tick();
    await new Promise((resolve) => setTimeout(resolve, 0)); // the service coalesces changes
    expect(results).toEqual([[], ['Text is required']]);
    expect(reads).toBe(2);
    sub.unsubscribe();
  });
});
