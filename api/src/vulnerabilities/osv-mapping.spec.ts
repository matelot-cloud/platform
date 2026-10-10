import { compareVersions, cvss3BaseScore, fixedVersionFor, osvQueryFor, severityFromScore } from './osv-mapping';

describe('OSV mapping', () => {
  it('maps purls to OSV ecosystems', () => {
    expect(osvQueryFor('pkg:npm/lodash@4.17.20')).toEqual({ ecosystem: 'npm', name: 'lodash', version: '4.17.20' });
    expect(osvQueryFor('pkg:npm/%40scope/pkg@1.0.0')).toEqual({ ecosystem: 'npm', name: '@scope/pkg', version: '1.0.0' });
    expect(osvQueryFor('pkg:maven/org.apache.logging.log4j/log4j-core@2.14.1')).toEqual({ ecosystem: 'Maven', name: 'org.apache.logging.log4j:log4j-core', version: '2.14.1' });
    expect(osvQueryFor('pkg:golang/github.com/gin-gonic/gin@v1.9.0')).toEqual({ ecosystem: 'Go', name: 'github.com/gin-gonic/gin', version: 'v1.9.0' });
    expect(osvQueryFor('pkg:apk/alpine/openssl@3.3.2-r0?arch=x86_64&distro=alpine-3.20.3')).toEqual({ ecosystem: 'Alpine:v3.20', name: 'openssl', version: '3.3.2-r0' });
    expect(osvQueryFor('pkg:deb/debian/openssl@3.0.11-1~deb12u2?arch=amd64&distro=debian-12')).toEqual({ ecosystem: 'Debian:12', name: 'openssl', version: '3.0.11-1~deb12u2' });
    expect(osvQueryFor('pkg:generic/thing@1')).toBeNull();
    expect(osvQueryFor('pkg:npm/no-version')).toBeNull();
  });

  it('compares versions loosely', () => {
    expect(compareVersions('1.2.10', '1.2.9')).toBeGreaterThan(0);
    expect(compareVersions('2.14.1', '2.15.0')).toBeLessThan(0);
    expect(compareVersions('v1.9.0', '1.9.0')).toBe(0);
    expect(compareVersions('3.0.11-1~deb12u2', '3.0.11-1~deb12u3')).toBeLessThan(0);
    expect(compareVersions('1.0.0-rc1', '1.0.0')).toBeLessThan(0);
  });

  it('finds the fixed version of the range containing the affected version', () => {
    const affected = [
      { package: { ecosystem: 'Maven', name: 'org.apache.logging.log4j:log4j-core' }, ranges: [{ type: 'ECOSYSTEM', events: [{ introduced: '2.0-beta9' }, { fixed: '2.3.1' }, { introduced: '2.4' }, { fixed: '2.12.2' }, { introduced: '2.13.0' }, { fixed: '2.15.0' }] }] },
    ];
    expect(fixedVersionFor(affected, 'Maven', 'org.apache.logging.log4j:log4j-core', '2.14.1')).toBe('2.15.0');
    expect(fixedVersionFor(affected, 'Maven', 'org.apache.logging.log4j:log4j-core', '2.5')).toBe('2.12.2');
    expect(fixedVersionFor(affected, 'Maven', 'other', '2.14.1')).toBeNull();
  });

  it('computes CVSS 3.1 base scores', () => {
    expect(cvss3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H')).toBe(10);
    expect(cvss3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')).toBe(9.8);
    expect(cvss3BaseScore('CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:N/A:N')).toBe(5.9);
    expect(cvss3BaseScore('CVSS:3.0/AV:L/AC:L/PR:L/UI:N/S:U/C:L/I:N/A:N')).toBe(3.3);
    expect(cvss3BaseScore('nonsense')).toBeNull();
    expect(severityFromScore(9.8)).toBe('critical');
    expect(severityFromScore(7)).toBe('high');
    expect(severityFromScore(4.2)).toBe('medium');
    expect(severityFromScore(null)).toBe('unknown');
  });
});


describe('Debian source packages (audit P2)', () => {
  it('queries the source package named by upstream=', () => {
    expect(osvQueryFor('pkg:deb/debian/libc6@2.41-12%2Bdeb13u4?arch=amd64&distro=debian-13.7&upstream=glibc')).toEqual({ ecosystem: 'Debian:13', name: 'glibc', version: '2.41-12+deb13u4' });
    expect(osvQueryFor('pkg:deb/debian/libncursesw6@6.5%2B20250216-2?arch=amd64&distro=debian-13.7&upstream=ncurses')?.name).toBe('ncurses');
    expect(osvQueryFor('pkg:deb/debian/perl-base@5.40.1-6%2Bdeb13u1?arch=amd64&distro=debian-13.7&upstream=perl')?.name).toBe('perl');
  });
  it('uses the source version when upstream carries one (binNMU +b1 differs)', () => {
    expect(osvQueryFor('pkg:deb/debian/zlib1g@1%3A1.3.dfsg%2Breally1.3.1-1%2Bb1?arch=amd64&distro=debian-13.7&upstream=zlib%401%3A1.3.dfsg%2Breally1.3.1-1')).toEqual({ ecosystem: 'Debian:13', name: 'zlib', version: '1:1.3.dfsg+really1.3.1-1' });
  });
  it('keeps the binary name when it is the source (openssl) and Ubuntu releases intact', () => {
    expect(osvQueryFor('pkg:deb/debian/openssl@3.5.7-1~deb13u2?arch=amd64&distro=debian-13.7')).toEqual({ ecosystem: 'Debian:13', name: 'openssl', version: '3.5.7-1~deb13u2' });
    expect(osvQueryFor('pkg:deb/ubuntu/libc6@2.35-0ubuntu3.8?distro=ubuntu-22.04&upstream=glibc')).toEqual({ ecosystem: 'Ubuntu:22.04', name: 'glibc', version: '2.35-0ubuntu3.8' });
  });
});
