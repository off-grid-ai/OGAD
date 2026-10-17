# Postfix: accept mail for farm.test from localhost only, deliver to dovecot LMTP. Nothing leaves the box.
postconf -e 'myhostname = mx.farm.test' 'mydestination = localhost' 'inet_interfaces = loopback-only' 'inet_protocols = ipv4' \
  'virtual_mailbox_domains = farm.test' 'virtual_transport = lmtp:inet:127.0.0.1:24' 'mynetworks = 127.0.0.0/8' \
  'relayhost = [127.0.0.1]:9' 'default_transport = error:outside mail is disabled on the clone farm' 'smtpd_relay_restrictions = permit_mynetworks, reject' \
  'maillog_file = /var/log/postfix-farm.log' 'compatibility_level = 3.6'
