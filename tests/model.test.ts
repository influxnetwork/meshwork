import { describe, expect, it } from 'vitest';
import { parseDeviceModel } from '../src/shared/model';

describe('parseDeviceModel', () => {
  it.each([
    ['CBS350-48FP-4G 48-Port Gigabit PoE Managed Switch', 'CBS350-48FP-4G'],
    ['SG350-28P 28-Port Gigabit PoE Managed Switch', 'SG350-28P'],
    ['Cisco IOS Software, C2960X Software (C2960X-UNIVERSALK9-M), Version 15.2(7)E4, RELEASE SOFTWARE (fc2)', 'C2960X'],
    ['ArubaOS (MODEL: 2930F-24G-PoE+-4SFP), Version WC.16.10.0012', '2930F-24G-PoE+-4SFP'],
    ['HPE OfficeConnect Switch 1820 24G J9980A, PT.02.11, Linux 3.6.5', 'OfficeConnect Switch 1820 24G J9980A'],
    ['RouterOS CRS328-24P-4S+', 'CRS328-24P-4S+'],
    ['UniFi USW-24-PoE, 6.5.59.14762, Linux 3.6.5', 'USW-24-PoE'],
    ['GS108Tv3 8-Port Gigabit Smart Managed Plus Switch', 'GS108Tv3'],
    ['Juniper Networks, Inc. ex2300-24p Ethernet Switch, kernel JUNOS 20.4R3', 'ex2300-24p'],
  ])('%s', (descr, model) => {
    expect(parseDeviceModel(descr).model).toBe(model);
  });

  it('reads the firmware version', () => {
    expect(parseDeviceModel('Cisco IOS Software, C2960X Software (C2960X-UNIVERSALK9-M), Version 15.2(7)E4, RELEASE').firmware).toBe('15.2(7)E4');
    expect(parseDeviceModel('ArubaOS (MODEL: 2930F-24G-PoE+-4SFP), Version WC.16.10.0012').firmware).toBe('WC.16.10.0012');
  });

  it('names UniFi OS consoles from their kernel tag', () => {
    expect(parseDeviceModel('Debian GNU/Linux 11 (bullseye) Linux 4.19.152-ui-alpine #4.19.152 SMP aarch64').model).toBe('UniFi OS console');
  });

  it('guesses nothing from a description without a model', () => {
    expect(parseDeviceModel('Netgate pfSense Plus pfSense.home.arpa 26.03.1-RELEASE FreeBSD 16.0-CURRENT amd64').model).toBeUndefined();
    expect(parseDeviceModel(undefined)).toEqual({});
  });
});
