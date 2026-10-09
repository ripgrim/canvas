import { Button } from '../atoms/Button';
import { Card } from '../atoms/Card';
import { Input } from '../atoms/Input';
import { Label } from '../atoms/Label';

export function LoginForm() {
  return (
    <><Card
        key={'b6ee18ef-2c9a-4c42-a00e-f1f512b9ae06:card'}
        heading={'Welcome back'}><Label key={'030daf19-87c5-48c0-9486-062c94329e89'} htmlFor={'email'}>{'Email'}</Label><Input
          key={'237eecbb-12a1-42c4-8bc1-107ca7bd68da'}
          id={'email'}
          type={'email'}
          placeholder={'you@example.com'} /><Label key={'f1371512-f25f-4d04-bd48-154870b30545'} htmlFor={'password'}>{'Password'}</Label><Input
          key={'989908e7-93bd-471d-ba85-381e9c314ac6'}
          id={'password'}
          type={'password'} /><Button key={'5333d3b7-7a56-412c-bc09-811eec5b327c'} variant={'primary'}>{'Sign in'}</Button></Card></>
  );
}
